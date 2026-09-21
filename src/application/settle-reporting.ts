/**
 * 通知処理の完了判定（Q07、A13、D09）。
 *
 * Q07の完了境界は「正式採用・読戻し・必要通知の受付まで」。確定通知だけでなく、
 * 非選定通知・募集終了通知も対象に含める（`COMPLETION_REQUIRES_NOTIFICATION_ACCEPTED`）。
 *
 * **通知が失敗しても勤務を取り消さない**（RFC-010 §7、D09）。採用事実は `ADOPTED` の
 * まま保持し、案件だけを `ATTENTION` へ回す。「未確定」と表示しない（ADR-022）。
 *
 * 未送信（`REFUSED`）と配送失敗（`FAILED`）を同じ扱いにしない。どちらも完了させないが、
 * 前者は外部作用が起きておらず、後者は試みて失敗している。`UNKNOWN` は失敗と断定せず、
 * 照合の経路（未実装）が入るまで待つ——ここで完了にも失敗にもしない。
 */

import "server-only";
import { withTransaction } from "../adapters/db/transaction";
import { COMPLETION_REQUIRES_NOTIFICATION_ACCEPTED } from "../config/mvp-policy";
import type { AbsenceCaseRepository, OutboxRepository } from "../contracts/repository";

export type SettleReportingOutcome =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly caseId: string;
      /** 完了させたか、要対応へ回したか、まだ待っているか。 */
      readonly to: "COMPLETED" | "ATTENTION" | "WAITING";
    };

export interface SettleReportingDeps {
  readonly cases: AbsenceCaseRepository;
  readonly outbox: OutboxRepository;
}

export function settleReporting(deps: SettleReportingDeps) {
  return async function runOnce(): Promise<SettleReportingOutcome> {
    return withTransaction(async (tx) => {
      // 通知処理中の案件を1件だけ見る。worker の1ステップ（RFC-003 §2）。
      const { rows } = await tx.query<{ case_id: string }>(
        `select case_id from absence_case
          where state = 'REPORTING'
          order by created_at
          for update skip locked
          limit 1`,
      );
      const caseId = rows[0]?.case_id;
      if (!caseId) return { handled: false as const };

      const snapshot = await deps.cases.lockForUpdate(tx, caseId);
      if (snapshot === "NOT_FOUND") return { handled: false as const };

      const items = await deps.outbox.listByCase(tx, caseId);
      // Q07：通知の受付までを完了境界にする。設定で緩めない限り、送信済みを待つ。
      const pending = items.filter(
        (item) => item.status === "PENDING" || item.status === "UNKNOWN",
      );
      const stuck = items.filter((item) => item.status === "FAILED" || item.status === "REFUSED");

      if (stuck.length > 0) {
        // D09：確定済みの勤務と採用事実は消さない。案件だけ要対応へ回す。
        await deps.cases.applyTransition(tx, {
          caseId,
          expectedVersion: snapshot.version,
          to: "ATTENTION",
        });
        await deps.cases.recordEvent(tx, {
          caseId,
          kind: "REPORTING_STUCK",
          detail: { failed: stuck.length },
        });
        return { handled: true as const, caseId, to: "ATTENTION" as const };
      }
      if (COMPLETION_REQUIRES_NOTIFICATION_ACCEPTED && pending.length > 0) {
        // まだ送っていない通知がある。結果不明も失敗と断定せず、ここでは待つ。
        return { handled: true as const, caseId, to: "WAITING" as const };
      }

      await deps.cases.applyTransition(tx, {
        caseId,
        expectedVersion: snapshot.version,
        to: "COMPLETED",
      });
      await deps.cases.recordEvent(tx, { caseId, kind: "CASE_COMPLETED" });
      return { handled: true as const, caseId, to: "COMPLETED" as const };
    });
  };
}
