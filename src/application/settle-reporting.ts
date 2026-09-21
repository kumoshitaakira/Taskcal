/**
 * 正式採用の**後始末**（RFC-010 §4 手順7、Q07、A07、A13、D09）。workerの1ステップ。
 *
 * 二つの仕事を持つ。どちらも「採用取引が commit した後に落ちた案件」を前へ進めるため。
 *
 *   1. `COMMITTED` → 正式版参照から読み直して照合し、`REPORTING` か `ATTENTION` へ。
 *   2. `REPORTING` → 必要な通知が受け付けられたら `COMPLETED` へ。
 *
 * **1 が要る理由**：採用取引（`adopt-plan.ts` の手順6）は `COMMITTED` を commit する。
 * 手順7は別取引・別の外部読み込みなので、その間に落ちると案件は `COMMITTED` のまま
 * 誰も進めない。同じ操作IDの再実行は保存済み結果を返すだけ、別の操作IDは「調整中では
 * ない」で断られる。確定事実は残るが業務が止まるので、復旧の口をここに置く。
 *
 * **勤務を取り消さない。** 読戻しが一致しなくても、通知が失敗しても、採用事実
 * （`ADOPTED`）と確定した勤務はそのまま保持して `ATTENTION` へ回す（D09、ADR-022）。
 * 「未確定」と表示しない。
 *
 * Q07の完了境界は「正式採用・読戻し・必要通知の受付まで」。確定通知だけでなく、
 * 非選定通知・募集終了通知も対象に含める（`COMPLETION_REQUIRES_NOTIFICATION_ACCEPTED`）。
 * 未送信（`REFUSED`）と配送失敗（`FAILED`）は同じ扱いにしない——どちらも完了させないが、
 * 前者は外部作用が起きておらず、後者は試みて失敗している。`UNKNOWN` は失敗と断定せず、
 * 照合の経路（未実装）が入るまで待つ。
 */

import "server-only";
import { withTransaction, type Tx } from "../adapters/db/transaction";
import type { ScheduleReadRepository } from "../adapters/db/schedule-repository";
import { COMPLETION_REQUIRES_NOTIFICATION_ACCEPTED } from "../config/mvp-policy";
import type {
  AbsenceCaseRepository,
  CaseSnapshot,
  OutboxRepository,
  ScheduleUpdateRepository,
  SelectionResultRepository,
} from "../contracts/repository";
import { matchesExpected, plannedAbsences, plannedAdditions } from "./adoption-check";

export type SettleReportingOutcome =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly caseId: string;
      /**
       * 何をしたか。
       *   - `VERIFIED`：読戻しが一致し、通知処理へ進めた
       *   - `ATTENTION`：読戻しまたは通知の問題。**勤務と採用事実は保持**
       *   - `COMPLETED`：必要な通知まで済んだ
       *   - `WAITING`：まだ送っていない通知がある。結果不明も失敗と断定しない
       */
      readonly to: "VERIFIED" | "COMPLETED" | "ATTENTION" | "WAITING";
    };

export interface SettleReportingDeps {
  readonly cases: AbsenceCaseRepository;
  readonly outbox: OutboxRepository;
  readonly scheduleUpdates: ScheduleUpdateRepository;
  readonly selections: SelectionResultRepository;
  readonly schedules: ScheduleReadRepository;
}

export function settleReporting(deps: SettleReportingDeps) {
  /** 手順7：正式版参照から読み直して照合する（D11／A01）。 */
  async function verifyAdoption(tx: Tx, snapshot: CaseSnapshot): Promise<SettleReportingOutcome> {
    const open = await deps.scheduleUpdates.findOpenByCase(tx, snapshot.caseId);
    // 採用済みの更新は終端なので `findOpenByCase` では引けない。採用した計画は
    // 正式版参照が指している（D11：参照から始める）。
    const adopted = await tx.query<{ schedule_update_id: string | null }>(
      `select adopted_by_schedule_update_id as schedule_update_id
         from authoritative_schedule_ref
        where connection_id = $1 and schedule_id = $2`,
      [snapshot.connectionId, snapshot.scheduleId],
    );
    const scheduleUpdateId = adopted.rows[0]?.schedule_update_id;

    if (open !== "NONE" || !scheduleUpdateId) {
      // 採用済みなのに正式版参照が採用元を指していない、または進行中の更新が残って
      // いる。自動では判断しない。確定事実は消さずに人の対応へ回す。
      await deps.cases.applyTransition(tx, {
        caseId: snapshot.caseId,
        expectedVersion: snapshot.version,
        to: "ATTENTION",
      });
      await deps.cases.recordEvent(tx, { caseId: snapshot.caseId, kind: "ADOPTION_REF_MISMATCH" });
      return { handled: true, caseId: snapshot.caseId, to: "ATTENTION" };
    }

    const stored = await deps.scheduleUpdates.findById(tx, scheduleUpdateId);
    const selection =
      stored === "NOT_FOUND" ? "NOT_FOUND" : await deps.selections.findById(tx, stored.selectionId);
    const loaded = await deps.schedules.loadByDate(tx, {
      connectionId: snapshot.connectionId,
      storeId: snapshot.storeId,
      businessDate: snapshot.businessDate,
    });

    const matches =
      selection !== "NOT_FOUND" &&
      loaded !== "NOT_ADOPTED" &&
      matchesExpected(
        loaded.assignments,
        plannedAdditions(selection, snapshot),
        plannedAbsences(snapshot),
        snapshot.caseId,
      );

    // D09：一致しなくても確定済みの勤務と採用事実は消さない。要対応にする（A07）。
    await deps.cases.applyTransition(tx, {
      caseId: snapshot.caseId,
      expectedVersion: snapshot.version,
      to: matches ? "REPORTING" : "ATTENTION",
    });
    await deps.cases.recordEvent(tx, {
      caseId: snapshot.caseId,
      kind: matches ? "ADOPTION_VERIFIED" : "ADOPTION_READBACK_MISMATCH",
    });
    return { handled: true, caseId: snapshot.caseId, to: matches ? "VERIFIED" : "ATTENTION" };
  }

  /** Q07：必要な通知が受け付けられたか。 */
  async function settleNotifications(
    tx: Tx,
    snapshot: CaseSnapshot,
  ): Promise<SettleReportingOutcome> {
    const items = await deps.outbox.listByCase(tx, snapshot.caseId);
    const pending = items.filter((item) => item.status === "PENDING" || item.status === "UNKNOWN");
    const stuck = items.filter((item) => item.status === "FAILED" || item.status === "REFUSED");

    if (stuck.length > 0) {
      // D09：確定済みの勤務と採用事実は消さない。案件だけ要対応へ回す（A13）。
      await deps.cases.applyTransition(tx, {
        caseId: snapshot.caseId,
        expectedVersion: snapshot.version,
        to: "ATTENTION",
      });
      await deps.cases.recordEvent(tx, {
        caseId: snapshot.caseId,
        kind: "REPORTING_STUCK",
        detail: { stuck: stuck.length },
      });
      return { handled: true, caseId: snapshot.caseId, to: "ATTENTION" };
    }
    if (COMPLETION_REQUIRES_NOTIFICATION_ACCEPTED && pending.length > 0) {
      // まだ送っていない通知がある。結果不明も失敗と断定せず、ここでは待つ。
      return { handled: true, caseId: snapshot.caseId, to: "WAITING" };
    }

    await deps.cases.applyTransition(tx, {
      caseId: snapshot.caseId,
      expectedVersion: snapshot.version,
      to: "COMPLETED",
    });
    await deps.cases.recordEvent(tx, { caseId: snapshot.caseId, kind: "CASE_COMPLETED" });
    return { handled: true, caseId: snapshot.caseId, to: "COMPLETED" };
  }

  return async function runOnce(): Promise<SettleReportingOutcome> {
    return withTransaction(async (tx) => {
      // 採用の後始末が残っている案件を1件だけ見る（RFC-003 §2：1ステップ）。
      const { rows } = await tx.query<{ case_id: string }>(
        `select case_id from absence_case
          where state in ('COMMITTED', 'REPORTING')
          order by created_at
          for update skip locked
          limit 1`,
      );
      const caseId = rows[0]?.case_id;
      if (!caseId) return { handled: false as const };

      const snapshot = await deps.cases.lockForUpdate(tx, caseId);
      if (snapshot === "NOT_FOUND") return { handled: false as const };
      return snapshot.state === "COMMITTED"
        ? verifyAdoption(tx, snapshot)
        : settleNotifications(tx, snapshot);
    });
  };
}
