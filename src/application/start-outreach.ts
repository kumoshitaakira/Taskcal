/**
 * 同時個別打診の開始（RFC-011 §2、ADR-013）。
 *
 * 候補の全員へ個別に打診する。グループチャットへ公開しない。「同時」は同じ募集で
 * 並行に開始することであり、全宛先への同時到達を保証する意味ではない。
 *
 * **現在の候補は名簿だけで選んでいる**（`roster-eligibility.ts`）。可能時間・月次上限・
 * 勤務の重複は未検査なので、「適格者全員」とは言えない。
 *
 * **この取引では送信しない。** 打診と通知待ちを積むだけで、送信はworkerが取引の外で
 * 行う（RFC-010 §5：外部API待ちを取引に入れない）。送信の操作IDと内容ハッシュは
 * この時点で確定させ、再試行で作り直さない（ADR-006）。
 *
 * 候補は名簿だけで選んでいる。可能時間・月次上限・重複は未検査（担当B、未実装）。
 * 詳細は `roster-eligibility.ts` を参照。
 */

import "server-only";
import { ERROR_CODES, type ErrorCode } from "../contracts/errors";
import { computeRequestHash } from "../contracts/operation";
import type { SendPayloadForHash } from "../contracts/messaging-gateway";
import type {
  AbsenceCaseRepository,
  Clock,
  IdGenerator,
  OperationResultStore,
  OutboxRepository,
  TxHandle,
  OutreachRepository,
} from "../contracts/repository";
import { withTransaction } from "../adapters/db/transaction";
import type { RosterEligibility } from "./roster-eligibility";
import { buildOfferBody } from "./offer-message";

export interface StartOutreachCommand {
  readonly operationId: string;
  readonly caseId: string;
}

export type StartOutreachResult =
  | { readonly ok: true; readonly started: number; readonly replayed: boolean }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

export interface StartOutreachDeps {
  readonly cases: AbsenceCaseRepository;
  readonly outreaches: OutreachRepository;
  readonly outbox: OutboxRepository;
  readonly operations: OperationResultStore;
  readonly roster: RosterEligibility;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * 検査で弾いたことを操作結果へ確定させる。
 *
 * **IN_PROGRESS のまま取引を閉じない。** 操作IDが内容から決まる操作では、一度失敗した
 * だけでその操作が「進行中」のまま残り、以後の再実行がすべて「結果不明」になって
 * 恒久的に塞がる。外部作用の前に自分で弾いた結果は**確定した拒否**であり、成否不明ではない。
 */
async function refuse(
  deps: { operations: OperationResultStore },
  tx: TxHandle,
  operationId: string,
  code: ErrorCode,
  detail: string,
) {
  await deps.operations.complete(tx, {
    operationId,
    status: "REFUSED",
    result: { code, detail },
  });
  return fail(code, detail);
}

function fail(code: ErrorCode, detail: string): StartOutreachResult {
  return { ok: false, code, detail };
}

/**
 * 送信の操作ID。打診ごと・種別ごとに一つ。
 * 再試行で作り直さないよう、乱数ではなく打診IDから決める（ADR-006）。
 */
export function sendOperationId(outreachId: string, kind: string): string {
  return `send:${outreachId}:${kind}`;
}

export function startOutreach(deps: StartOutreachDeps) {
  return async function run(command: StartOutreachCommand): Promise<StartOutreachResult> {
    const requestHash = computeRequestHash({ caseId: command.caseId });
    const now = deps.clock.now();

    return withTransaction(async (tx) => {
      const begun = await deps.operations.begin(tx, {
        operation: { operationId: command.operationId, requestHash },
        kind: "START_OUTREACH",
        caseId: command.caseId,
      });
      if (begun.match === "CONFLICT") {
        return fail(ERROR_CODES.OPERATION_CONFLICT, "同じ操作IDで内容が異なります。");
      }
      if (begun.match === "REPLAY" && begun.stored?.status === "REFUSED") {
        // 前回、外部作用の前に自分で弾いた操作。同じ結果を返す（作り直さない）。
        const stored = begun.stored.result as { code?: ErrorCode; detail?: string } | undefined;
        return fail(
          stored?.code ?? ERROR_CODES.INVALID_INPUT,
          stored?.detail ?? "同じ操作は前回拒否しています。",
        );
      }
      if (begun.match === "REPLAY") {
        const stored = begun.stored?.result as { started?: number } | undefined;
        if (typeof stored?.started === "number") {
          return { ok: true, started: stored.started, replayed: true };
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
      // D10：停止後は新規打診を行わない。確定済みの事実は保持する。
      if (snapshot.stoppedAt) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.CASE_STOPPED,
          "停止済みの案件です。新規の打診は行いません。",
        );
      }
      if (snapshot.state !== "COORDINATING") {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          `調整中の案件ではありません（現在: ${snapshot.state}）。`,
        );
      }
      if (Date.parse(now) >= Date.parse(snapshot.deadlineAt)) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.DEADLINE_EXCEEDED,
          "回答期限を過ぎています。",
        );
      }

      const existing = await deps.outreaches.listByCase(tx, command.caseId);
      if (existing.length > 0) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.OPERATION_CONFLICT,
          "この案件ではすでに打診を開始しています。",
        );
      }

      const store = await tx.query<{ name: string; timezone: string }>(
        "select name, timezone from store where store_id = $1",
        [snapshot.storeId],
      );
      const storeRow = store.rows[0];
      if (!storeRow) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          "店舗が見つかりません。",
        );
      }

      const candidates = await deps.roster.listEligible(tx, {
        storeId: snapshot.storeId,
        connectionId: snapshot.connectionId,
        absentStaffId: snapshot.absentStaffId,
        requirement: {
          roleCode: snapshot.roleCode,
          startAt: snapshot.requiredStartAt,
          endAt: snapshot.requiredEndAt,
        },
        inputs: {
          connectionId: snapshot.connectionId,
          scheduleId: snapshot.scheduleId,
          // 正式版参照の版はこの段階では使わない。選定・正式採用の入力版は
          // SelectionResult が持つ（D08）。
          sourceRevision: "",
          monthlyCompleteness: "UNKNOWN",
          missingDates: [],
        },
      });

      if (candidates.length === 0) {
        // 候補が居ないことと、打診に失敗したことを混同しない。
        await deps.cases.recordEvent(tx, { caseId: command.caseId, kind: "NO_CANDIDATES" });
        await deps.operations.complete(tx, {
          operationId: command.operationId,
          status: "SUCCEEDED",
          result: { started: 0 },
        });
        return { ok: true, started: 0, replayed: false };
      }

      const body = buildOfferBody({
        storeName: storeRow.name,
        roleLabel: snapshot.roleCode,
        timeZone: storeRow.timezone,
        startAt: snapshot.requiredStartAt,
        endAt: snapshot.requiredEndAt,
        deadlineAt: snapshot.deadlineAt,
      });

      for (const [index, candidate] of candidates.entries()) {
        const outreachId = deps.ids.next();
        const endpoint = {
          provider: "mock",
          connectionId: snapshot.connectionId,
          endpointKey: candidate.endpointKey,
          endpointVersion: candidate.endpointVersion,
        };

        await deps.outreaches.create(tx, {
          outreachId,
          caseId: command.caseId,
          staffId: candidate.staffId,
          endpoint,
          offeredStartAt: candidate.offeredStartAt,
          offeredEndAt: candidate.offeredEndAt,
          // モデルへ渡す参照。実名・連絡先をプロンプトへ入れない（ADR-008）。
          anonymousStaffRef: `staff-${index + 1}`,
        });

        // 宛先を丸ごとハッシュに含める。provider と connectionId を落とすと、
        // 接続先だけ切り替えた再試行が同じハッシュになる（A15）。
        const payload: SendPayloadForHash = { to: endpoint, kind: "INITIAL_OFFER", body };
        await deps.outbox.enqueue(tx, {
          outboxId: deps.ids.next(),
          caseId: command.caseId,
          outreachId,
          kind: "INITIAL_OFFER",
          body,
          operation: {
            operationId: sendOperationId(outreachId, "INITIAL_OFFER"),
            requestHash: computeRequestHash(payload),
          },
          connectionId: snapshot.connectionId,
        });
      }

      await deps.cases.recordEvent(tx, {
        caseId: command.caseId,
        kind: "OUTREACH_STARTED",
        detail: { count: candidates.length },
      });
      await deps.operations.complete(tx, {
        operationId: command.operationId,
        status: "SUCCEEDED",
        result: { started: candidates.length },
      });

      return { ok: true, started: candidates.length, replayed: false };
    });
  };
}
