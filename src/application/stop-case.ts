/**
 * 案件の停止（RFC-012 §5 A18、RFC-009 D10、ADR-022 / Q13）。
 *
 * 店長の明示的な停止と、期限・上限・候補枯渇による停止を同じ入口で扱う。行き先だけが
 * 理由で変わる（`resolvePreparingStop`）。
 *
 * **確定済みの事実を消さない（D10）。** `COMMITTED` 以降は停止しない。採用済み勤務の
 * 取消は別の変更操作であり、MVPの範囲外。
 *
 * **`PREPARING` 中は期限を検知しただけで引き継がない（Q13）。** 未決の `ScheduleUpdate`
 * が残っているあいだは状態を動かさず、停止の事実だけを確定させる。並行する正式採用の
 * 結果を先に確定させてから行き先を決める（`recover-case.ts` が受け皿）。
 *
 * 停止は取り消せない。再開の経路は用意しない（D10：確定済みの取消は別の変更操作）。
 */

import "server-only";
import { withTransaction } from "../adapters/db/transaction";
import {
  handoffReasonOf,
  resolvePreparingStop,
  STOP_CAUSE,
  type CaseState,
  type StopCause,
} from "../contracts/case-state";
import { ERROR_CODES, TaskcalError, type ErrorCode } from "../contracts/errors";
import type { SendPayloadForHash } from "../contracts/messaging-gateway";
import { computeRequestHash } from "../contracts/operation";
import { isAllowedOutreachTransition } from "../contracts/outreach-state";
import { isAllowedCommitmentTransition } from "../contracts/commitment";
import type {
  AbsenceCaseRepository,
  CaseSnapshot,
  Clock,
  CommitmentRepository,
  IdGenerator,
  OperationResultStore,
  OutboxRepository,
  OutreachRepository,
  ScheduleUpdateRepository,
  StoreRepository,
  TxHandle,
} from "../contracts/repository";
import { buildCaseClosedBody } from "./offer-message";
import { sendOperationId } from "./start-outreach";

export interface StopCaseCommand {
  readonly operationId: string;
  readonly caseId: string;
  readonly cause: StopCause;
}

/**
 * `DEFERRED` は「停止を確定させたが、行き先はまだ決めていない」。
 * 未採用と断定していないので、これを失敗として表示しない（ADR-022）。
 */
export type StopCaseResult =
  | {
      readonly ok: true;
      readonly to: CaseState | "DEFERRED";
      readonly notified: number;
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

export interface StopCaseDeps {
  readonly cases: AbsenceCaseRepository;
  readonly outreaches: OutreachRepository;
  readonly commitments: CommitmentRepository;
  readonly outbox: OutboxRepository;
  readonly scheduleUpdates: ScheduleUpdateRepository;
  readonly operations: OperationResultStore;
  readonly stores: StoreRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

function fail(code: ErrorCode, detail: string): StopCaseResult {
  return { ok: false, code, detail };
}

/**
 * 並行更新で止まったことを、**取引を巻き戻して**伝える。
 *
 * ここで値を返すと取引が commit し、`operations.begin` が作った `IN_PROGRESS` が
 * 残る。期限停止の操作IDは `stop:{caseId}:deadline` で固定なので、一度でも残ると
 * 以後その案件は「同じ操作が進行中です」を返し続け、**二度と期限停止できなくなる**。
 *
 * 自分で弾いた拒否（`refuse`）とは別物であることに注意する。あちらは確定した拒否で、
 * 保存して再実行を防ぐのが目的。こちらは再試行してよい一時的な競合。
 */
function abortOnConflict(detail: string): never {
  throw new TaskcalError(ERROR_CODES.RECONCILE_REQUIRED, detail);
}

/**
 * 検査で弾いたことを操作結果へ確定させる。IN_PROGRESS のまま閉じない
 * （`start-outreach.ts` の `refuse` と同じ理由）。
 */
async function refuse(
  deps: { operations: OperationResultStore },
  tx: TxHandle,
  operationId: string,
  code: ErrorCode,
  detail: string,
): Promise<StopCaseResult> {
  await deps.operations.complete(tx, {
    operationId,
    status: "REFUSED",
    result: { code, detail },
  });
  return fail(code, detail);
}

/** 停止で閉じる打診の状態。終端（`EXPIRED`・`CLOSED`）は動かさない。 */
const CLOSABLE_OUTREACH_STATES = [
  "PENDING_SEND",
  "SENT",
  "AWAITING_REPLY",
  "CLARIFYING",
  "ANSWERED",
] as const;

export function stopCase(deps: StopCaseDeps) {
  /**
   * 打診・承諾を失効させ、募集終了を積む。停止と**同じ取引**で行う。
   *
   * 返すのは**この呼出しで積んだ**通知の件数。すでに積まれていたものは数えない。
   */
  async function closeOutreaches(tx: TxHandle, snapshot: CaseSnapshot): Promise<number> {
    const store = await deps.stores.findById(tx, snapshot.storeId);
    if (store === "NOT_FOUND") {
      throw new TaskcalError(ERROR_CODES.INVALID_INPUT, "店舗が見つかりません。");
    }

    const outreaches = await deps.outreaches.listByCase(tx, snapshot.caseId);
    let notified = 0;

    for (const outreach of outreaches) {
      const closable = (CLOSABLE_OUTREACH_STATES as readonly string[]).includes(outreach.state);
      if (!closable) continue;

      // **打診が届いたと確認できていない相手へ「募集終了」を送らない。**
      // `adopt-plan.ts` の `enqueueNotifications` と同じ規則。同じ受信箱に「打診」と
      // 「終了しました」が続けて入るのを避ける。
      if (outreach.state === "PENDING_SEND") {
        await deps.cases.recordEvent(tx, {
          caseId: snapshot.caseId,
          kind: "CASE_CLOSED_SKIPPED",
          detail: { outreachId: outreach.outreachId, reason: "NOT_DELIVERED" },
        });
      } else {
        const body = buildCaseClosedBody({
          storeName: store.name,
          roleLabel: snapshot.roleCode,
          timeZone: store.timezone,
          startAt: snapshot.requiredStartAt,
          endAt: snapshot.requiredEndAt,
          deadlineAt: snapshot.deadlineAt,
        });
        // 宛先を丸ごとハッシュに含める（A15）。操作IDは正式採用時の募集終了通知と
        // 同じ規則なので、採用後の停止でも二重に積まれない（on conflict do nothing）。
        const payload: SendPayloadForHash = { to: outreach.endpoint, kind: "CASE_CLOSED", body };
        const enqueued = await deps.outbox.enqueue(tx, {
          outboxId: deps.ids.next(),
          caseId: snapshot.caseId,
          outreachId: outreach.outreachId,
          kind: "CASE_CLOSED",
          body,
          operation: {
            operationId: sendOperationId(outreach.outreachId, "CASE_CLOSED"),
            requestHash: computeRequestHash(payload),
          },
          connectionId: snapshot.connectionId,
        });
        // 正式採用時にすでに積んだ募集終了は足さない。画面の件数が水増しになる。
        if (enqueued === "ENQUEUED") notified += 1;
      }

      // 矢印だけで動かさない。遷移表を通す。
      if (!isAllowedOutreachTransition(outreach.state, "EXPIRED")) continue;
      const moved = await deps.outreaches.applyTransition(tx, {
        outreachId: outreach.outreachId,
        expectedVersion: outreach.version,
        to: "EXPIRED",
      });
      if (moved === "VERSION_CONFLICT") {
        // 同じ取引でロック済みの案件配下にある。ここで競合するのは異常。
        throw new Error(`打診 ${outreach.outreachId} の失効で版が競合しました。`);
      }
    }

    const commitments = await deps.commitments.listByCase(tx, snapshot.caseId);
    for (const commitment of commitments) {
      if (!isAllowedCommitmentTransition(commitment.status, "EXPIRED")) continue;
      await deps.commitments.changeStatus(tx, {
        commitmentId: commitment.commitmentId,
        to: "EXPIRED",
      });
    }

    return notified;
  }

  return async function run(command: StopCaseCommand): Promise<StopCaseResult> {
    // 理由まで含めてハッシュにする。同じ操作IDで別の理由は拒否する（D07）。
    const requestHash = computeRequestHash({ caseId: command.caseId, cause: command.cause });
    const now = deps.clock.now();

    return withTransaction(async (tx) => {
      const begun = await deps.operations.begin(tx, {
        operation: { operationId: command.operationId, requestHash },
        kind: "STOP_CASE",
        caseId: command.caseId,
      });
      if (begun.match === "CONFLICT") {
        return fail(ERROR_CODES.OPERATION_CONFLICT, "同じ操作IDで内容が異なります。");
      }
      if (begun.match === "REPLAY" && begun.stored?.status === "REFUSED") {
        const stored = begun.stored.result as { code?: ErrorCode; detail?: string } | undefined;
        return fail(
          stored?.code ?? ERROR_CODES.INVALID_INPUT,
          stored?.detail ?? "同じ操作は前回拒否しています。",
        );
      }
      if (begun.match === "REPLAY") {
        const stored = begun.stored?.result as
          { to?: CaseState | "DEFERRED"; notified?: number } | undefined;
        if (stored?.to) {
          return { ok: true, to: stored.to, notified: stored.notified ?? 0, replayed: true };
        }
        return fail(ERROR_CODES.RECONCILE_REQUIRED, "同じ操作が進行中です。");
      }

      const snapshot = await deps.cases.lockForUpdate(tx, command.caseId);
      if (snapshot === "NOT_FOUND") {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          "案件が見つかりません。",
        );
      }
      if (snapshot.stoppedAt) {
        // 別の操作IDからの二度目の停止。理由を上書きしない。
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.CASE_STOPPED,
          "すでに停止しています。停止は取り消せません。",
        );
      }

      // --- 行き先を決める。理由と状態の両方で変わる。 ---
      if (snapshot.state === "COORDINATING") {
        // 店長停止は CANCELLED、それ以外（期限・上限・枯渇）は人への引き継ぎ。
        const to: CaseState =
          command.cause === STOP_CAUSE.MANAGER_STOP ? "CANCELLED" : "HANDED_OFF";
        const notified = await closeOutreaches(tx, snapshot);
        const moved = await deps.cases.applyTransition(tx, {
          caseId: snapshot.caseId,
          expectedVersion: snapshot.version,
          to,
          stop: { cause: command.cause, at: now },
          ...(to === "HANDED_OFF"
            ? {
                handoff: {
                  reason: handoffReasonOf(command.cause),
                  // 調整中なので未採用。採用済みの案件はここへ来ない。
                  adoptionFact: snapshot.adoptionFact,
                  handedOffAt: now,
                },
              }
            : {}),
        });
        if (moved === "VERSION_CONFLICT") {
          abortOnConflict("案件が同時に更新されました。");
        }
        await deps.cases.recordEvent(tx, {
          caseId: snapshot.caseId,
          kind: "CASE_STOPPED",
          detail: { cause: command.cause, to, notified },
        });
        await deps.operations.complete(tx, {
          operationId: command.operationId,
          status: "SUCCEEDED",
          result: { to, notified },
        });
        return { ok: true, to, notified, replayed: false };
      }

      if (snapshot.state === "PREPARING") {
        const open = await deps.scheduleUpdates.findOpenByCase(tx, snapshot.caseId);
        if (open !== "NONE") {
          // Q13：期限を検知しただけで引き継がない。並行する正式採用の結果を先に
          // 確定させる。ここで終端へ落とすと、外部へ適用済みかもしれない計画を
          // 「未採用」と断定することになる。
          //
          // 打診・承諾は閉じてよい。停止の事実は確定しており、D10により新規打診は
          // 行わない。行き先だけを保留する。
          const notified = await closeOutreaches(tx, snapshot);
          const marked = await deps.cases.recordStop(tx, {
            caseId: snapshot.caseId,
            expectedVersion: snapshot.version,
            stop: { cause: command.cause, at: now },
          });
          if (marked !== "UPDATED") {
            abortOnConflict("案件が同時に更新されました。");
          }
          await deps.cases.recordEvent(tx, {
            caseId: snapshot.caseId,
            kind: "CASE_STOP_DEFERRED",
            detail: { cause: command.cause, scheduleUpdateId: open.scheduleUpdateId, notified },
          });
          await deps.operations.complete(tx, {
            operationId: command.operationId,
            status: "SUCCEEDED",
            result: { to: "DEFERRED", notified },
          });
          return { ok: true, to: "DEFERRED", notified, replayed: false };
        }

        // 未決の更新が無い。採用事実を見て行き先を決める（ADR-022）。
        const to = resolvePreparingStop({
          adoptionFact: snapshot.adoptionFact,
          cause: command.cause,
        });
        const notified = await closeOutreaches(tx, snapshot);
        const moved = await deps.cases.applyTransition(tx, {
          caseId: snapshot.caseId,
          expectedVersion: snapshot.version,
          to,
          stop: { cause: command.cause, at: now },
          ...(to === "HANDED_OFF"
            ? {
                handoff: {
                  reason: handoffReasonOf(command.cause),
                  adoptionFact: snapshot.adoptionFact,
                  handedOffAt: now,
                },
              }
            : {}),
        });
        if (moved === "VERSION_CONFLICT") {
          abortOnConflict("案件が同時に更新されました。");
        }
        await deps.cases.recordEvent(tx, {
          caseId: snapshot.caseId,
          kind: "CASE_STOPPED",
          detail: { cause: command.cause, to, notified },
        });
        await deps.operations.complete(tx, {
          operationId: command.operationId,
          status: "SUCCEEDED",
          result: { to, notified },
        });
        return { ok: true, to, notified, replayed: false };
      }

      // D10：`COMMITTED` 以降は停止しない。確定済みの事実を消さない。
      // 終端（COMPLETED / HANDED_OFF / CANCELLED）も同じ。
      return refuse(
        deps,
        tx,
        command.operationId,
        ERROR_CODES.INVALID_INPUT,
        `停止できる状態ではありません（現在: ${snapshot.state}）。確定済みの取消は別の操作です。`,
      );
    });
  };
}
