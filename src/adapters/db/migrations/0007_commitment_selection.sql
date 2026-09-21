-- 0007: 承諾・選定結果・勤務表更新。担当A（Day 2）。
--
-- 正式採用の進行（application 側）は次段階で実装する。ここで作るのは、二重採用を
-- DB側で止める制約を含むテーブル。migration は後から書き換えられないため、制約は
-- 使う前に置く。

-- RFC-011 §4：訂正で内容を上書きせず、新しいIDと supersedes を作る。
create table commitment (
  commitment_id uuid primary key,
  case_id uuid not null references absence_case (case_id),
  staff_id uuid not null references staff (staff_id),
  outreach_id uuid not null references outreach (outreach_id),
  version integer not null check (version > 0),
  supersedes uuid references commitment (commitment_id),
  accepted_interpretation_id uuid not null
    references reply_interpretation (interpretation_id),
  -- D03：打診・選定・確定で条件を一致させる。
  role_code text not null check (role_code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null check (
    status in ('ACTIVE', 'HELD', 'SUPERSEDED', 'WITHDRAWN', 'EXPIRED')
  ),
  -- この承諾を生んだ受信順。最新判定に時刻を使わない。
  source_received_seq bigint not null,
  created_at timestamptz not null default now(),
  constraint commitment_range check (start_at < end_at),
  constraint commitment_version_unique unique (case_id, staff_id, version),
  -- 1つの版を2つの新版が置き換えない（訂正履歴を枝分かれさせない）。
  constraint commitment_supersedes_unique unique (supersedes)
);

-- D04：同一案件・スタッフで選定可能な版は一つ。
create unique index commitment_one_selectable
  on commitment (case_id, staff_id)
  where status = 'ACTIVE';

create index commitment_case on commitment (case_id);

-- 不変の選定結果（RFC-009 §3）。承諾0件の評価でも残す。
create table selection_result (
  selection_id uuid primary key,
  case_id uuid not null references absence_case (case_id),
  -- 検査した時点の案件版。正式採用の直前に照合する（D08）。
  case_version integer not null,
  rules_version text not null,
  outcome text not null check (outcome in ('FEASIBLE', 'NOT_FEASIBLE')),
  not_feasible_reason text check (
    not_feasible_reason in (
      'NO_COMMITMENTS', 'NOT_COVERED', 'OVERLAP', 'MONTHLY_CAP', 'INPUT_INCOMPLETE'
    )
  ),
  connection_id text not null,
  schedule_id uuid not null references schedule (schedule_id),
  -- D08：対象日の版だけで全前提を代表させない。月内入力の完全性まで記録する。
  source_revision text not null,
  monthly_completeness text not null
    check (monthly_completeness in ('COMPLETE', 'INCOMPLETE', 'UNKNOWN')),
  missing_dates date[] not null default '{}',
  decided_at timestamptz not null,
  constraint selection_result_reason_pair check (
    (outcome = 'NOT_FEASIBLE') = (not_feasible_reason is not null)
  )
);

create index selection_result_case on selection_result (case_id, decided_at);

create table selection_item (
  selection_id uuid not null references selection_result (selection_id),
  commitment_id uuid not null references commitment (commitment_id),
  -- 選んだ承諾の版。status だけでなく版まで一致させて再検査する（D04）。
  commitment_version integer not null,
  selected boolean not null,
  -- 採用時に作る勤務ID。選定の時点で確定させ、再試行で採番し直さない（RFC-010 §3）。
  planned_shift_assignment_id uuid,
  primary key (selection_id, commitment_id),
  -- 選ばれた項目だけが勤務IDを持つ。
  constraint selection_item_planned_pair check (selected = (planned_shift_assignment_id is not null))
);

-- RFC-010 §6・§7：出力生成・検査・正式採用・成否照合を区別する。
create table schedule_update (
  schedule_update_id uuid primary key,
  case_id uuid not null references absence_case (case_id),
  selection_id uuid not null references selection_result (selection_id),
  operation_id text not null unique references operation_result (operation_id),
  connection_id text not null,
  schedule_id uuid not null references schedule (schedule_id),
  expected_source_revision text not null,
  state text not null check (
    state in ('PREPARING', 'PREPARED', 'ADOPTED', 'RECONCILE_REQUIRED', 'REJECTED')
  ),
  result_kind text check (
    result_kind in (
      'PREPARED', 'APPLIED', 'NOT_APPLIED', 'CONFLICT', 'PARTIAL', 'UNKNOWN', 'EXPORTED_ONLY'
    )
  ),
  artifact_ref text,
  new_source_revision text,
  revision_check_enforced boolean not null default false,
  adopted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint schedule_update_adopted_pair check ((state = 'ADOPTED') = (adopted_at is not null))
);

-- D05：1案件で正式採用する計画は一つ。**別の操作キーでも二重採用しない。**
create unique index schedule_update_one_adopted_per_case
  on schedule_update (case_id)
  where state = 'ADOPTED';

create index schedule_update_case on schedule_update (case_id, created_at);

-- 0002 で外部キーを付けられなかった参照をここで足す。
alter table shift_assignment
  add constraint shift_assignment_source_commitment
  foreign key (source_commitment_id) references commitment (commitment_id);

alter table authoritative_schedule_ref
  add constraint authoritative_schedule_ref_adopted_by
  foreign key (adopted_by_schedule_update_id) references schedule_update (schedule_update_id);
