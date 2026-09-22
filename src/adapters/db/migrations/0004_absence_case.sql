-- 0004: 欠勤案件。担当A（Day 2）。
--
-- RFC-011 §5、ADR-017、ADR-022。案件・相手別対話・勤務表更新・メッセージ配送は
-- 別々の状態管理主体とする。案件状態で他を代表させない。

create table absence_case (
  case_id uuid primary key,
  store_id uuid not null references store (store_id),
  connection_id text not null,
  schedule_id uuid not null references schedule (schedule_id),
  business_date date not null,
  -- D01：欠勤区間は元勤務内。Q04により全時間欠勤のみなので「欠勤区間 = 元勤務」。
  absent_shift_assignment_id uuid not null references shift_assignment (shift_assignment_id),
  -- D01：欠勤者本人は代替候補から除く。
  absent_staff_id uuid not null references staff (staff_id),
  role_code text not null check (role_code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  required_start_at timestamptz not null,
  required_end_at timestamptz not null,
  deadline_at timestamptz not null,
  state text not null check (
    state in (
      'COORDINATING', 'PREPARING', 'COMMITTED', 'RECONCILE_REQUIRED',
      'REPORTING', 'ATTENTION', 'COMPLETED', 'HANDED_OFF', 'CANCELLED'
    )
  ),
  -- 楽観ロック。読んだ版と一致する場合だけ更新する（D08）。
  version integer not null default 1,
  -- ADR-022：採用事実は案件状態と**別に**持つ。状態から採用可否を推定しない。
  adoption_fact text not null default 'NOT_ADOPTED'
    check (adoption_fact in ('NOT_ADOPTED', 'ADOPTED', 'UNKNOWN')),
  handoff_reason text check (
    handoff_reason in (
      'CANDIDATES_EXHAUSTED', 'DEADLINE_REACHED', 'LIMIT_REACHED',
      'RECONCILE_STALLED', 'REPORTING_FAILED'
    )
  ),
  handed_off_at timestamptz,
  stop_cause text check (
    stop_cause in ('MANAGER_STOP', 'DEADLINE', 'LIMIT', 'CANDIDATES_EXHAUSTED')
  ),
  stopped_at timestamptz,
  -- 受信順の採番元。案件内で単調増加させる（RFC-011 §4）。
  -- sequence を使わない。ロールバックしたときに欠番が残り、受信の取りこぼしと
  -- 区別できなくなるため。
  next_inbound_seq bigint not null default 1,
  run_id text not null,
  created_at timestamptz not null default now(),
  constraint absence_case_range check (required_start_at < required_end_at),
  -- ADR-022：HANDED_OFF は理由と時刻を必ず伴う。無いと何を引き継いだか説明できない。
  constraint absence_case_handoff_reason check (
    (state = 'HANDED_OFF') = (handoff_reason is not null)
  ),
  constraint absence_case_handoff_time check ((state = 'HANDED_OFF') = (handed_off_at is not null)),
  constraint absence_case_stop_pair check ((stop_cause is null) = (stopped_at is null))
);

-- D02：同じ欠勤区間について稼働中の重複案件を作らない。
-- Q04により欠勤区間は元勤務そのものなので、元勤務IDの一意性が D02 にあたる。
create unique index absence_case_one_active_per_absence
  on absence_case (absent_shift_assignment_id)
  where state not in ('COMPLETED', 'HANDED_OFF', 'CANCELLED');

-- RFC-009 §2：MVPは同時1案件。範囲宣言をDB側でも守る。
create unique index absence_case_one_active_per_store
  on absence_case (store_id)
  where state not in ('COMPLETED', 'HANDED_OFF', 'CANCELLED');

-- 追記履歴。現在状態の正本ではない（RFC-009 §3）。操作・検査・失敗の証拠。
create table case_processing_event (
  event_id uuid primary key,
  case_id uuid not null references absence_case (case_id),
  kind text not null,
  -- 秘密情報・不要な個人情報・メッセージ原文を入れない（AGENTS.md、ADR-008）。
  detail jsonb,
  created_at timestamptz not null default now()
);

create index case_processing_event_case on case_processing_event (case_id, created_at);

-- 代替勤務の由来。0002 では案件テーブルが無いため、ここで外部キーを足す。
alter table shift_assignment
  add constraint shift_assignment_source_case
  foreign key (source_case_id) references absence_case (case_id);
