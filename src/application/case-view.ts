/**
 * 店長画面の読み取りモデル。
 *
 * ADR-017 / ADR-022：案件・相手別対話・勤務表更新・メッセージ配送・採用事実を
 * **別々に**返す。1つの状態へ畳まない。畳むと、採用済みなのに通知が失敗した案件を
 * 「未確定」と表示しかねない。
 */

import "server-only";
import type { AdoptionFact, CaseState } from "../contracts/case-state";
import {
  isSelectableCommitment,
  type CommitmentBlockReason,
  type CommitmentStatus,
} from "../contracts/commitment";
import type {
  DeliveryState,
  OutreachMessageKind,
  OutreachState,
} from "../contracts/outreach-state";
import type { OutboxStatus } from "../contracts/repository";
import type { ScheduleUpdateState } from "../contracts/schedule-update";
import { withTransaction } from "../adapters/db/transaction";

export interface OutreachView {
  readonly outreachId: string;
  readonly staffName: string;
  readonly state: OutreachState;
  /** 最後の送信操作の配送状態。未送信（REFUSED）は配送状態を持たない。 */
  readonly delivery?: DeliveryState;
  /** 未送信の理由。配送失敗と区別する。 */
  readonly refusal?: string;
  readonly commitmentStatus?: CommitmentStatus;
  /**
   * D04：この承諾を選定へ出せるか。**status だけで決めない。**
   * 未処理の新しい返信・置き換え・期限も見る（A05）。
   */
  readonly selectable: boolean;
  readonly blockReason?: CommitmentBlockReason;
  readonly lastReceivedSeq?: number;
  readonly appliedSeq: number;
  readonly offeredStartAt: string;
  readonly offeredEndAt: string;
}

export interface OutboxCountView {
  readonly kind: OutreachMessageKind;
  readonly status: OutboxStatus;
  readonly count: number;
}

export interface ScheduleUpdateView {
  readonly scheduleUpdateId: string;
  readonly state: ScheduleUpdateState;
  readonly operationId: string;
  readonly artifactRef?: string;
}

export interface CaseView {
  readonly caseId: string;
  readonly state: CaseState;
  readonly version: number;
  /** ADR-022：案件状態から推定しない。 */
  readonly adoptionFact: AdoptionFact;
  readonly handoffReason?: string;
  readonly stopCause?: string;
  readonly businessDate: string;
  readonly requiredStartAt: string;
  readonly requiredEndAt: string;
  readonly deadlineAt: string;
  readonly absentStaffName: string;
  readonly outreaches: readonly OutreachView[];
  readonly outbox: readonly OutboxCountView[];
  readonly scheduleUpdates: readonly ScheduleUpdateView[];
  /** 打診と結び付かなかった受信。捨てていないことを画面に出す（A15）。 */
  readonly unmatchedInbound: number;
}

export interface ShiftOption {
  readonly shiftAssignmentId: string;
  readonly staffName: string;
  readonly businessDate: string;
  readonly startAt: string;
  readonly endAt: string;
}

export interface ManagerView {
  readonly storeId?: string;
  readonly storeName?: string;
  readonly connectionId?: string;
  readonly timeZone: string;
  readonly activeCase?: CaseView;
  readonly recentCases: readonly { caseId: string; state: CaseState; businessDate: string }[];
  /** 欠勤登録の選択肢。予定済みの勤務だけ。 */
  readonly shiftOptions: readonly ShiftOption[];
}

const DEFAULT_TIME_ZONE = "Asia/Tokyo";

export async function getManagerView(now: string): Promise<ManagerView> {
  return withTransaction(async (tx) => {
    // MVPは架空の1店舗（RFC-009 §2）。複数店舗を扱わない。
    const store = await tx.query<{ store_id: string; name: string; timezone: string }>(
      "select store_id, name, timezone from store order by created_at limit 1",
    );
    const storeRow = store.rows[0];
    if (!storeRow) {
      return { timeZone: DEFAULT_TIME_ZONE, recentCases: [], shiftOptions: [] };
    }

    const connection = await tx.query<{ connection_id: string }>(
      `select distinct connection_id from authoritative_schedule_ref
         where schedule_id in (select schedule_id from schedule where store_id = $1)
         limit 1`,
      [storeRow.store_id],
    );
    const connectionId = connection.rows[0]?.connection_id;

    const shiftOptions = connectionId
      ? (
          await tx.query<{
            shift_assignment_id: string;
            staff_name: string;
            business_date: string;
            start_at: Date;
            end_at: Date;
          }>(
            `select a.shift_assignment_id, s.display_name as staff_name,
                    to_char(sc.business_date, 'YYYY-MM-DD') as business_date,
                    a.start_at, a.end_at
               from shift_assignment a
               join schedule sc on sc.schedule_id = a.schedule_id
               join staff s on s.staff_id = a.staff_id
               join authoritative_schedule_ref r
                 on r.schedule_id = sc.schedule_id and r.connection_id = $2
              where a.store_id = $1 and a.status = 'SCHEDULED' and a.start_at >= $3
              order by a.start_at
              limit 20`,
            [storeRow.store_id, connectionId, now],
          )
        ).rows.map((row) => ({
          shiftAssignmentId: row.shift_assignment_id,
          staffName: row.staff_name,
          businessDate: row.business_date,
          startAt: row.start_at.toISOString(),
          endAt: row.end_at.toISOString(),
        }))
      : [];

    const cases = await tx.query<{
      case_id: string;
      state: CaseState;
      version: number;
      adoption_fact: AdoptionFact;
      handoff_reason: string | null;
      stop_cause: string | null;
      business_date: string;
      required_start_at: Date;
      required_end_at: Date;
      deadline_at: Date;
      absent_staff_name: string;
      active: boolean;
    }>(
      `select c.case_id, c.state, c.version, c.adoption_fact, c.handoff_reason, c.stop_cause,
              to_char(c.business_date, 'YYYY-MM-DD') as business_date,
              c.required_start_at, c.required_end_at, c.deadline_at,
              s.display_name as absent_staff_name,
              (c.state not in ('COMPLETED', 'HANDED_OFF', 'CANCELLED')) as active
         from absence_case c
         join staff s on s.staff_id = c.absent_staff_id
        where c.store_id = $1
        order by c.created_at desc
        limit 10`,
      [storeRow.store_id],
    );

    const activeRow = cases.rows.find((row) => row.active);
    const activeCase = activeRow
      ? {
          caseId: activeRow.case_id,
          state: activeRow.state,
          version: activeRow.version,
          adoptionFact: activeRow.adoption_fact,
          handoffReason: activeRow.handoff_reason ?? undefined,
          stopCause: activeRow.stop_cause ?? undefined,
          businessDate: activeRow.business_date,
          requiredStartAt: activeRow.required_start_at.toISOString(),
          requiredEndAt: activeRow.required_end_at.toISOString(),
          deadlineAt: activeRow.deadline_at.toISOString(),
          absentStaffName: activeRow.absent_staff_name,
          outreaches: await loadOutreaches(tx, activeRow.case_id, {
            deadlineAt: activeRow.deadline_at.toISOString(),
            now,
          }),
          outbox: await loadOutbox(tx, activeRow.case_id),
          scheduleUpdates: await loadScheduleUpdates(tx, activeRow.case_id),
          unmatchedInbound: await countUnmatched(tx, activeRow.case_id),
        }
      : undefined;

    return {
      storeId: storeRow.store_id,
      storeName: storeRow.name,
      connectionId,
      timeZone: storeRow.timezone,
      activeCase,
      recentCases: cases.rows.map((row) => ({
        caseId: row.case_id,
        state: row.state,
        businessDate: row.business_date,
      })),
      shiftOptions,
    };
  });
}

type Tx = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function loadOutreaches(
  tx: Tx,
  caseId: string,
  at: { deadlineAt: string; now: string },
): Promise<readonly OutreachView[]> {
  const { rows } = await tx.query<{
    outreach_id: string;
    staff_name: string;
    state: OutreachState;
    delivery: DeliveryState | null;
    refusal: string | null;
    commitment_status: CommitmentStatus | null;
    last_received_seq: string | null;
    last_applied_seq: string;
    offered_start_at: Date;
    offered_end_at: Date;
  }>(
    `select o.outreach_id,
            st.display_name as staff_name,
            o.state,
            -- 最後の送信操作の配送状態。未送信（REFUSED）は配送を持たない。
            (select d.state from message_delivery d
               join outreach_message m on m.message_id = d.message_id
              where m.outreach_id = o.outreach_id
              order by d.created_at desc limit 1) as delivery,
            (select b.refusal from notification_outbox b
              where b.outreach_id = o.outreach_id and b.status = 'REFUSED'
              order by b.created_at desc limit 1) as refusal,
            (select c.status from commitment c
              where c.outreach_id = o.outreach_id
              order by c.version desc limit 1) as commitment_status,
            (select max(e.received_seq) from inbound_event e
              where e.outreach_id = o.outreach_id) as last_received_seq,
            o.last_applied_seq,
            o.offered_start_at, o.offered_end_at
       from outreach o
       join staff st on st.staff_id = o.staff_id
      where o.case_id = $1
      order by st.display_name, o.outreach_id`,
    [caseId],
  );

  return rows.map((row) => {
    const lastReceivedSeq = row.last_received_seq ? Number(row.last_received_seq) : undefined;
    const appliedSeq = Number(row.last_applied_seq);
    // D04：承諾が無ければ選定できない。あっても status だけでは決めない。
    const selectability = row.commitment_status
      ? isSelectableCommitment({
          status: row.commitment_status,
          hasUnprocessedReply: (lastReceivedSeq ?? 0) > appliedSeq,
          deadlineAt: at.deadlineAt,
          now: at.now,
        })
      : ({ selectable: false, reason: "NOT_ACTIVE" } as const);

    return {
      outreachId: row.outreach_id,
      staffName: row.staff_name,
      state: row.state,
      delivery: row.delivery ?? undefined,
      refusal: row.refusal ?? undefined,
      commitmentStatus: row.commitment_status ?? undefined,
      selectable: selectability.selectable,
      blockReason: selectability.selectable ? undefined : selectability.reason,
      lastReceivedSeq,
      appliedSeq,
      offeredStartAt: row.offered_start_at.toISOString(),
      offeredEndAt: row.offered_end_at.toISOString(),
    };
  });
}

async function loadOutbox(tx: Tx, caseId: string): Promise<readonly OutboxCountView[]> {
  const { rows } = await tx.query<{ kind: OutreachMessageKind; status: OutboxStatus; n: number }>(
    `select kind, status, count(*)::int as n from notification_outbox
      where case_id = $1 group by kind, status order by kind, status`,
    [caseId],
  );
  return rows.map((row) => ({ kind: row.kind, status: row.status, count: row.n }));
}

async function loadScheduleUpdates(tx: Tx, caseId: string): Promise<readonly ScheduleUpdateView[]> {
  const { rows } = await tx.query<{
    schedule_update_id: string;
    state: ScheduleUpdateState;
    operation_id: string;
    artifact_ref: string | null;
  }>(
    `select schedule_update_id, state, operation_id, artifact_ref
       from schedule_update where case_id = $1 order by created_at desc`,
    [caseId],
  );
  return rows.map((row) => ({
    scheduleUpdateId: row.schedule_update_id,
    state: row.state,
    operationId: row.operation_id,
    artifactRef: row.artifact_ref ?? undefined,
  }));
}

async function countUnmatched(tx: Tx, caseId: string): Promise<number> {
  // 打診と結び付かなかった受信。案件に紐づかないので接続範囲で数える。
  const { rows } = await tx.query<{ n: number }>(
    `select count(*)::int as n from inbound_event e
      where e.case_id is null
        and e.connection_id = (select connection_id from absence_case where case_id = $1)`,
    [caseId],
  );
  return rows[0]?.n ?? 0;
}
