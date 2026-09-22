-- 0015: 案件の停止操作と、通知の照合。担当A（Day 3）。
--
-- RFC-012 §5 A18（店長停止、予算・回数・期限到達）と A13（確定通知失敗からの復旧）。
-- ADR-022：停止は確定済みの事実を消さない。ADR-006：停止も操作IDで冪等にする。

-- 停止を一つの操作として記録する。期限検知は安定した操作ID（stop:<caseId>:deadline）で
-- 呼ぶため、再起動しても同じ停止を二度成立させない（D07）。
alter table operation_result drop constraint operation_result_operation_kind_check;

alter table operation_result add constraint operation_result_operation_kind_check check (
  operation_kind in (
    'CREATE_CASE', 'START_OUTREACH', 'SEND_MESSAGE',
    'INTERPRET_REPLY', 'APPLY_UPDATE', 'ADOPT_PLAN', 'STOP_CASE'
  )
);

-- 0005 の索引は status in ('PENDING','FAILED') を覆っていたが、claimNext は PENDING しか
-- 取らない。FAILED の側は誰も走査しない死んだ索引だった。
--
-- FAILED の自動再送は入れない。同じ operation_id での再送は operation_result に保存済みの
-- 失敗を REPLAY で返すだけで、空回りにしかならない（README「動かないもの」）。
-- 本当の再送には attempt を含む操作IDが要る。
drop index notification_outbox_claimable;

create index notification_outbox_claimable
  on notification_outbox (next_attempt_at)
  where status = 'PENDING';

-- 結果不明の通知を照合する走査用（A13）。再送はせず getSendResult で照合する。
create index notification_outbox_reconcilable
  on notification_outbox (created_at)
  where status = 'UNKNOWN';

-- 期限に達した案件の走査用（A18）。停止済みは対象外。
create index absence_case_deadline_sweep
  on absence_case (deadline_at)
  where stopped_at is null and state in ('COORDINATING', 'PREPARING');

-- 照合・復旧の対象になる案件の走査用（A13／Q11／Q12）。
create index absence_case_recoverable
  on absence_case (created_at)
  where state in ('RECONCILE_REQUIRED', 'ATTENTION');
