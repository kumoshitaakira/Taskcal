/**
 * 欠勤案件の作成（RFC-009 D01・D02、Q04、Q05）。
 *
 * 店長の登録操作。ここから自動調整が始まる。
 *
 * 決定的なコードで検査すること（モデルに委ねない）：
 *   - 対象勤務が実在し、予定済みで、店舗・職種が一致する（D01）
 *   - Q04：欠勤は元勤務の全時間。区間の一部だけの指定は範囲外として拒否する
 *   - Q05：日跨ぎは範囲外として拒否する。黙って同一営業日へ丸めない
 *   - 期限が現在より後で、元勤務の開始より前
 *   - D02：同じ欠勤区間について稼働中の案件を二つ作らない
 */

import "server-only";
import { ERROR_CODES, type ErrorCode } from "../contracts/errors";
import { computeRequestHash } from "../contracts/operation";
import type {
  AbsenceCaseRepository,
  CaseSnapshot,
  Clock,
  IdGenerator,
  OperationResultStore,
  TxHandle,
} from "../contracts/repository";
import type { ConnectionId, ShiftAssignmentId } from "../contracts/schedule-gateway";
import type { ScheduleReadRepository } from "../adapters/db/schedule-repository";
import { withTransaction } from "../adapters/db/transaction";

export interface CreateAbsenceCaseCommand {
  /** 画面が描画時に作った安定キー。二重クリック・再読込は同じ値になる。 */
  readonly operationId: string;
  readonly storeId: string;
  readonly connectionId: ConnectionId;
  readonly absentShiftAssignmentId: ShiftAssignmentId;
  readonly deadlineAt: string;
  readonly runId: string;
}

export type CreateAbsenceCaseResult =
  | { readonly ok: true; readonly caseId: string; readonly replayed: boolean }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

export interface CreateAbsenceCaseDeps {
  readonly cases: AbsenceCaseRepository;
  readonly schedules: ScheduleReadRepository;
  readonly operations: OperationResultStore;
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

function fail(code: ErrorCode, detail: string): CreateAbsenceCaseResult {
  return { ok: false, code, detail };
}

/** 営業日（店舗timezone）。Q05の判定に使う。 */
function businessDateOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function createAbsenceCase(deps: CreateAbsenceCaseDeps) {
  return async function run(command: CreateAbsenceCaseCommand): Promise<CreateAbsenceCaseResult> {
    const requestHash = computeRequestHash({
      storeId: command.storeId,
      connectionId: command.connectionId,
      absentShiftAssignmentId: command.absentShiftAssignmentId,
      deadlineAt: command.deadlineAt,
    });
    const now = deps.clock.now();

    return withTransaction(async (tx) => {
      const begun = await deps.operations.begin(tx, {
        operation: { operationId: command.operationId, requestHash },
        kind: "CREATE_CASE",
        connectionId: command.connectionId,
        // 案件はまだ無い。作成後に complete で結果を書く。
      });

      if (begun.match === "CONFLICT") {
        return fail(
          ERROR_CODES.OPERATION_CONFLICT,
          "同じ操作IDで内容が異なります。画面を読み直してください。",
        );
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
        const stored = begun.stored?.result as { caseId?: string } | undefined;
        if (stored?.caseId) {
          return { ok: true, caseId: stored.caseId, replayed: true };
        }
        // 開始したが完了していない操作。作り直さず、結果不明として扱う。
        return fail(
          ERROR_CODES.RECONCILE_REQUIRED,
          "同じ操作が進行中です。結果を確認してから再実行してください。",
        );
      }

      const store = await tx.query<{ timezone: string; role_code: string }>(
        "select timezone, role_code from store where store_id = $1",
        [command.storeId],
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

      const target = await tx.query<{
        shift_assignment_id: string;
        schedule_id: string;
        staff_id: string;
        role_code: string;
        start_at: Date;
        end_at: Date;
        status: string;
        business_date: string;
      }>(
        // date 型を Date で受けるとローカル深夜として解釈され、JSTでは日付が1日ずれる。
        // 営業日は文字列のまま受け取る。
        `select a.shift_assignment_id, a.schedule_id, a.staff_id, a.role_code,
                a.start_at, a.end_at, a.status,
                to_char(s.business_date, 'YYYY-MM-DD') as business_date
           from shift_assignment a
           join schedule s on s.schedule_id = a.schedule_id
          where a.shift_assignment_id = $1 and a.store_id = $2`,
        [command.absentShiftAssignmentId, command.storeId],
      );
      const shift = target.rows[0];
      if (!shift) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          "対象の勤務が見つかりません。",
        );
      }

      // D11：正式版参照を経由して読めることを確かめる。参照が無い勤務表は
      // 「取り込んでいない」であり「勤務が無い」ではない。
      const businessDate = shift.business_date;
      const loaded = await deps.schedules.loadByDate(tx, {
        connectionId: command.connectionId,
        storeId: command.storeId,
        businessDate,
      });
      if (loaded === "NOT_ADOPTED") {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          "この営業日の正式版参照がありません。勤務表を取り込んでください。",
        );
      }

      if (shift.status !== "SCHEDULED") {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          `予定済みの勤務ではありません（現在: ${shift.status}）。`,
        );
      }
      if (shift.role_code !== storeRow.role_code) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.OUT_OF_SCOPE,
          "MVPは職種1種類のみを扱います。",
        );
      }

      const startAt = shift.start_at.toISOString();
      const endAt = shift.end_at.toISOString();

      // Q05：日跨ぎは範囲外。黙って同一営業日へ丸めない。
      if (
        businessDateOf(startAt, storeRow.timezone) !== businessDate ||
        businessDateOf(endAt, storeRow.timezone) !== businessDate
      ) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.OUT_OF_SCOPE,
          "日跨ぎの勤務は対応範囲外です。",
        );
      }

      const deadline = Date.parse(command.deadlineAt);
      if (Number.isNaN(deadline)) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          "回答期限の形式が不正です。",
        );
      }
      if (deadline <= Date.parse(now)) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          "回答期限が現在より前です。",
        );
      }
      if (deadline > Date.parse(startAt)) {
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.INVALID_INPUT,
          "回答期限が勤務開始より後です。",
        );
      }

      const caseId = deps.ids.next();
      const created = await deps.cases.create(tx, {
        caseId,
        storeId: command.storeId,
        connectionId: command.connectionId,
        scheduleId: shift.schedule_id,
        businessDate,
        absentShiftAssignmentId: command.absentShiftAssignmentId,
        absentStaffId: shift.staff_id,
        roleCode: shift.role_code,
        // Q04：欠勤は元勤務の全時間。必要枠は元勤務と同じ区間になる。
        requiredStartAt: startAt,
        requiredEndAt: endAt,
        deadlineAt: command.deadlineAt,
        runId: command.runId,
      });

      if (created === "DUPLICATE_ACTIVE_CASE") {
        // D02。進行中の案件がある。作らずに理由を返す。
        return refuse(
          deps,
          tx,
          command.operationId,
          ERROR_CODES.OPERATION_CONFLICT,
          "この勤務、またはこの店舗で進行中の案件があります。",
        );
      }

      await deps.cases.recordEvent(tx, {
        caseId,
        kind: "CASE_CREATED",
        detail: { absentShiftAssignmentId: command.absentShiftAssignmentId },
      });
      await deps.operations.complete(tx, {
        operationId: command.operationId,
        status: "SUCCEEDED",
        result: { caseId },
      });

      return { ok: true, caseId, replayed: false };
    });
  };
}

export type { CaseSnapshot };
