/**
 * 同時個別打診の開始（RFC-011 §2、ADR-013、D01、A11）。
 *
 * 候補の全員へ個別に打診する。グループチャットへ公開しない。「同時」は同じ募集で
 * 並行に開始することであり、全宛先への同時到達を保証する意味ではない。
 *
 * 候補の決め方（Day 4で担当Bの規則へ繋いだ）：
 *   1. 名簿（同店舗・同職種・在籍中・欠勤者本人を除く）を引く（`roster-eligibility.ts`）
 *   2. 正式版参照から**打診の直前に**月内勤務表を読む（取引の外。RFC-010 §5）
 *   3. 担当Bの規則で在籍・店舗・職種・本人除外・同日の勤務との重複・月次上限を検査し、
 *      適格な相手だけへ打診する（`outreach-eligibility.ts`）。外した相手は理由つきで
 *      履歴に残す（打診されなかった人が記録から消えないように）
 *
 * **可能時間そのものは検査していない。** 可能時間表が無く、必要枠を可能時間として渡す。
 *
 * **この取引では送信しない。** 打診と通知待ちを積むだけで、送信はworkerが取引の外で
 * 行う（RFC-010 §5：外部API待ちを取引に入れない）。送信の操作IDと内容ハッシュは
 * この時点で確定させ、再試行で作り直さない（ADR-006）。
 *
 * 取引の分け方：
 *   取引A  操作の登録、案件と正式版参照の読取り、外部作用前の拒否
 *   外     月内勤務表の読込み（ファイル読取り。長いDB取引の中で待たない）
 *   取引B  案件をロックして版を照合し、名簿・条件を読み、判定し、打診と通知待ちを積む
 */

import "server-only";
import { ERROR_CODES, TaskcalError, type ErrorCode } from "../contracts/errors";
import { computeRequestHash } from "../contracts/operation";
import type { SendPayloadForHash } from "../contracts/messaging-gateway";
import type {
  AbsenceCaseRepository,
  AuthoritativeRefSnapshot,
  AuthoritativeScheduleRefRepository,
  CaseSnapshot,
  Clock,
  IdGenerator,
  OperationResultStore,
  OutboxRepository,
  OutreachRepository,
  StaffRepository,
  StoreRepository,
  TxHandle,
} from "../contracts/repository";
import type { LoadedSchedule, ScheduleGateway } from "../contracts/schedule-gateway";
import type { EligibilityChecker } from "../contracts/selection";
import { assertOutsideTransaction, withTransaction } from "../adapters/db/transaction";
import type { RosterEligibility } from "./roster-eligibility";
import { buildListEligibleInput } from "./outreach-eligibility";
import { buildOfferBody } from "./offer-message";

export interface StartOutreachCommand {
  readonly operationId: string;
  readonly caseId: string;
}

export type StartOutreachResult =
  | {
      readonly ok: true;
      readonly started: number;
      /** 名簿には居たが、適格性の検査で外した人数。 */
      readonly excluded: number;
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

export interface StartOutreachDeps {
  readonly cases: AbsenceCaseRepository;
  readonly outreaches: OutreachRepository;
  readonly outbox: OutboxRepository;
  readonly operations: OperationResultStore;
  readonly roster: RosterEligibility;
  readonly stores: StoreRepository;
  /** 適格性の判定へ渡すスタッフ条件を読む（Q15と同じ形）。 */
  readonly staff: StaffRepository;
  /** D11：月内勤務表は正式版参照から読む。 */
  readonly authoritative: AuthoritativeScheduleRefRepository;
  readonly gateway: Pick<ScheduleGateway, "loadSchedule">;
  readonly eligibility: Pick<EligibilityChecker, "listEligible">;
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
  // **確定済みの結果を上書きしない。** 同じ操作IDの並行呼出しが先に打診を積んで
  // `SUCCEEDED` にしていれば、こちらの拒否理由（勤務表を読めない等）で戻してはいけない。
  // 確定済みならその結果を再生する。
  const stored = await deps.operations.findById(tx, operationId);
  if (stored !== "NOT_FOUND" && stored.status !== "IN_PROGRESS") {
    if (stored.status === "SUCCEEDED") {
      const result = stored.result as { started?: number; excluded?: number } | undefined;
      return {
        ok: true as const,
        started: result?.started ?? 0,
        excluded: result?.excluded ?? 0,
        replayed: true,
      };
    }
    const previous = stored.result as { code?: ErrorCode; detail?: string } | undefined;
    return fail(previous?.code ?? code, previous?.detail ?? detail);
  }
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

/** 取引Aの結果。断ったならその結果、進めるなら読んだ案件と正式版参照。 */
type Head =
  | { readonly done: StartOutreachResult }
  | { readonly snapshot: CaseSnapshot; readonly ref: AuthoritativeRefSnapshot };

export function startOutreach(deps: StartOutreachDeps) {
  return async function run(command: StartOutreachCommand): Promise<StartOutreachResult> {
    const requestHash = computeRequestHash({ caseId: command.caseId });
    const now = deps.clock.now();

    // --- 取引A：操作の登録と、外部作用の前の拒否 ---
    const head = await withTransaction(async (tx): Promise<Head> => {
      const begun = await deps.operations.begin(tx, {
        operation: { operationId: command.operationId, requestHash },
        kind: "START_OUTREACH",
        caseId: command.caseId,
      });
      if (begun.match === "CONFLICT") {
        return { done: fail(ERROR_CODES.OPERATION_CONFLICT, "同じ操作IDで内容が異なります。") };
      }
      if (begun.match === "REPLAY" && begun.stored?.status === "REFUSED") {
        // 前回、外部作用の前に自分で弾いた操作。同じ結果を返す（作り直さない）。
        const stored = begun.stored.result as { code?: ErrorCode; detail?: string } | undefined;
        return {
          done: fail(
            stored?.code ?? ERROR_CODES.INVALID_INPUT,
            stored?.detail ?? "同じ操作は前回拒否しています。",
          ),
        };
      }
      if (begun.match === "REPLAY") {
        const stored = begun.stored?.result as { started?: number; excluded?: number } | undefined;
        if (typeof stored?.started === "number") {
          return {
            done: {
              ok: true as const,
              started: stored.started,
              excluded: stored.excluded ?? 0,
              replayed: true,
            },
          };
        }
        // 「進行中」のまま残った操作。取引Aの後・取引Bの前で落ちた可能性がある。
        // 打診は取引Bで操作の完了と同時に積まれるので、**打診が1件も無ければ何も効いて
        // いない**。案件固定の操作IDなので、ここで断ると案件は二度と打診できなくなる。
        // 打診が無いなら続きを進め、あるなら並行実行が居るので断る。
        const already = await deps.outreaches.listByCase(tx, command.caseId);
        if (already.length > 0) {
          return {
            done: fail(
              ERROR_CODES.RECONCILE_REQUIRED,
              "同じ操作が進行中です。読み直してください。",
            ),
          };
        }
      }

      const snapshot = await deps.cases.findById(tx, command.caseId);
      if (snapshot === "NOT_FOUND") {
        return {
          done: await refuse(
            deps,
            tx,
            command.operationId,
            ERROR_CODES.INVALID_INPUT,
            "案件が見つかりません。",
          ),
        };
      }
      // D10：停止後は新規打診を行わない。確定済みの事実は保持する。
      if (snapshot.stoppedAt) {
        return {
          done: await refuse(
            deps,
            tx,
            command.operationId,
            ERROR_CODES.CASE_STOPPED,
            "停止済みの案件です。新規の打診は行いません。",
          ),
        };
      }
      if (snapshot.state !== "COORDINATING") {
        return {
          done: await refuse(
            deps,
            tx,
            command.operationId,
            ERROR_CODES.INVALID_INPUT,
            `調整中の案件ではありません（現在: ${snapshot.state}）。`,
          ),
        };
      }
      if (Date.parse(now) >= Date.parse(snapshot.deadlineAt)) {
        return {
          done: await refuse(
            deps,
            tx,
            command.operationId,
            ERROR_CODES.DEADLINE_EXCEEDED,
            "回答期限を過ぎています。",
          ),
        };
      }
      const existing = await deps.outreaches.listByCase(tx, command.caseId);
      if (existing.length > 0) {
        return {
          done: await refuse(
            deps,
            tx,
            command.operationId,
            ERROR_CODES.OPERATION_CONFLICT,
            "この案件ではすでに打診を開始しています。",
          ),
        };
      }
      const ref = await deps.authoritative.get(tx, {
        connectionId: snapshot.connectionId,
        scheduleId: snapshot.scheduleId,
      });
      if (ref === "NOT_FOUND") {
        return {
          done: await refuse(
            deps,
            tx,
            command.operationId,
            ERROR_CODES.INVALID_INPUT,
            "正式版参照がありません。勤務表を取り込んでください。",
          ),
        };
      }
      return { snapshot, ref };
    });
    if ("done" in head) return head.done;
    const { snapshot, ref } = head;

    // --- 外：打診の直前に月内勤務表を読む（D11）。長いDB取引の中で待たない。 ---
    assertOutsideTransaction("勤務表の読込み");
    let loaded: LoadedSchedule;
    try {
      loaded = await deps.gateway.loadSchedule({
        connectionId: snapshot.connectionId,
        scheduleId: snapshot.scheduleId,
        authoritative: ref,
      });
    } catch (error) {
      // 読込みは外部作用ではない。何も作っていないので確定した拒否にしてよい。
      // 想定外の例外（EACCES 等）の文面はローカルパスを含み得る。定型文にする（ADR-008）。
      const code = error instanceof TaskcalError ? error.code : ERROR_CODES.INVALID_INPUT;
      const detail = error instanceof TaskcalError ? error.message : "勤務表を読めません。";
      return withTransaction((tx) => refuse(deps, tx, command.operationId, code, detail));
    }

    // --- 取引B：ロックして版を照合し、判定し、打診を積む ---
    return withTransaction(async (tx) => {
      const locked = await deps.cases.lockForUpdate(tx, command.caseId);
      if (locked === "NOT_FOUND" || locked.version !== snapshot.version) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.REVISION_CONFLICT,
          "案件が並行して更新されました。読み直してください。",
        );
      }
      // 期限は取引Aで見たが、勤務表の読込みの間に過ぎていることがある。案件版は時間の
      // 経過では動かないので、時計を取り直してもう一度検査する（A18の期限側）。
      if (Date.parse(deps.clock.now()) >= Date.parse(locked.deadlineAt)) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.DEADLINE_EXCEEDED,
          "回答期限を過ぎています。",
        );
      }
      if ((await deps.outreaches.listByCase(tx, command.caseId)).length > 0) {
        // 同じ操作の並行実行が先に積んだなら、その結果を再生する。ここで REFUSED を
        // 書くと、先に確定した SUCCEEDED を上書きする。
        const stored = await deps.operations.findById(tx, command.operationId);
        if (stored !== "NOT_FOUND" && stored.status === "SUCCEEDED") {
          const result = stored.result as { started?: number; excluded?: number } | undefined;
          return {
            ok: true as const,
            started: result?.started ?? 0,
            excluded: result?.excluded ?? 0,
            replayed: true,
          };
        }
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.OPERATION_CONFLICT,
          "この案件ではすでに打診を開始しています。",
        );
      }

      // 読んだ勤務表の版が、今も正式版か（取引の外で読んでいる間に再取込み等が入り得る）。
      const current = await deps.authoritative.get(tx, {
        connectionId: locked.connectionId,
        scheduleId: locked.scheduleId,
      });
      if (current === "NOT_FOUND" || current.sourceRevision !== loaded.sourceRevision) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.REVISION_CONFLICT,
          "勤務表の版が読んだ後に変わっています。読み直してください。",
        );
      }

      const store = await deps.stores.findById(tx, locked.storeId);
      if (store === "NOT_FOUND") {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          "店舗が見つかりません。",
        );
      }

      let listing;
      try {
        // 名簿の上限超過（Q10）も含めて、検査で弾いたものは確定した拒否として閉じる。
        // 例外のまま取引を巻き戻すと、操作が「進行中」のまま残る。
        const roster = await deps.roster.listRoster(tx, {
          storeId: locked.storeId,
          connectionId: locked.connectionId,
          roleCode: locked.roleCode,
          absentStaffId: locked.absentStaffId,
        });
        const conditions = await deps.staff.listConditionsByStore(tx, locked.storeId);
        listing = deps.eligibility.listEligible(
          buildListEligibleInput({
            snapshot: locked,
            storeTimezone: store.timezone,
            reloaded: loaded,
            conditions,
            roster,
          }),
        );
      } catch (error) {
        if (error instanceof TaskcalError) {
          // 月内入力の不足・範囲外など。何も作っていないので確定した拒否。
          return refuse(deps, tx, command.operationId, error.code, error.message);
        }
        throw error;
      }

      if (listing.excluded.length > 0) {
        // 打診されなかった人と理由を残す。名簿には居たが適格でなかった相手。
        await deps.cases.recordEvent(tx, {
          caseId: command.caseId,
          kind: "CANDIDATES_EXCLUDED",
          detail: { excluded: listing.excluded },
        });
      }

      if (listing.eligible.length === 0) {
        // 候補が居ないことと、打診に失敗したことを混同しない。
        await deps.cases.recordEvent(tx, { caseId: command.caseId, kind: "NO_CANDIDATES" });
        await deps.operations.complete(tx, {
          operationId: command.operationId,
          status: "SUCCEEDED",
          result: { started: 0, excluded: listing.excluded.length },
        });
        return { ok: true, started: 0, excluded: listing.excluded.length, replayed: false };
      }

      const body = buildOfferBody({
        storeName: store.name,
        roleLabel: locked.roleCode,
        timeZone: store.timezone,
        startAt: locked.requiredStartAt,
        endAt: locked.requiredEndAt,
        deadlineAt: locked.deadlineAt,
      });

      for (const [index, candidate] of listing.eligible.entries()) {
        const outreachId = deps.ids.next();
        const endpoint = {
          provider: "mock",
          connectionId: locked.connectionId,
          endpointKey: candidate.endpointKey,
          endpointVersion: candidate.endpointVersion,
        };

        await deps.outreaches.create(tx, {
          outreachId,
          caseId: command.caseId,
          staffId: candidate.staffId,
          endpoint,
          // 提示するのは必要枠そのもの。永続層の形（UTC ISO）に揃える。
          offeredStartAt: locked.requiredStartAt,
          offeredEndAt: locked.requiredEndAt,
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
          connectionId: locked.connectionId,
        });
      }

      await deps.cases.recordEvent(tx, {
        caseId: command.caseId,
        kind: "OUTREACH_STARTED",
        detail: {
          count: listing.eligible.length,
          excluded: listing.excluded.length,
          sourceRevision: loaded.sourceRevision,
        },
      });
      await deps.operations.complete(tx, {
        operationId: command.operationId,
        status: "SUCCEEDED",
        result: { started: listing.eligible.length, excluded: listing.excluded.length },
      });

      return {
        ok: true,
        started: listing.eligible.length,
        excluded: listing.excluded.length,
        replayed: false,
      };
    });
  };
}
