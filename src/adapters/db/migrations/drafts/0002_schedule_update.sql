-- 0002: ScheduleUpdateの永続化下書き（B作成／A確認待ち）。
--
-- Schedule、AbsenceCase、SelectionResult、Commitmentの最終schemaは未確定のため、
-- ここではそれらへの外部キーを作らず、参照値を保持する。採用済み事実
-- (adoption_fact) と ScheduleUpdate 自身の状態 (state) は別列で保存し、案件状態を
-- この表から推定しない。正式採用処理への接続はA確認後に行う。

create table schedule_update (
  schedule_update_id uuid primary key,
  case_id uuid not null,
  schedule_id uuid not null,
  -- SelectionResultの参照形式はA確認待ち。最終tableへの外部キーは置かない。
  selection_result_ref text,
  connection_id text not null,
  operation_id text not null,
  request_hash text not null,
  expected_source_revision text not null,
  source_revision_after text,
  revision_check_enforced boolean not null default false,
  artifact_ref text,
  state text not null,
  -- 外部作用前にIN_FLIGHTを保存する。再起動後に再送せず照合するための境界。
  external_attempt_state text not null default 'IN_FLIGHT',
  result_kind text,
  read_back_status text not null default 'NOT_ATTEMPTED',
  read_back_source_revision text,
  read_back_artifact_ref text,
  read_back_detail text,
  -- 案件状態とは別の採用事実。UNKNOWNを未採用へ丸めない。
  adoption_fact text not null default 'NOT_ADOPTED',
  -- Commitment/SelectionResultの対応はA確認待ち。JSONの形は契約確定まで不透明に保持する。
  result_mappings jsonb not null default '[]'::jsonb,
  result_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint schedule_update_operation_key
    unique (connection_id, operation_id),
  constraint schedule_update_operation_id_length
    check (char_length(operation_id) between 1 and 128),
  constraint schedule_update_request_hash_format
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint schedule_update_state_values
    check (state in ('PREPARING', 'PREPARED', 'ADOPTED', 'RECONCILE_REQUIRED', 'REJECTED')),
  constraint schedule_update_result_kind_values
    check (result_kind is null or result_kind in (
      'PREPARED', 'APPLIED', 'NOT_APPLIED', 'CONFLICT', 'PARTIAL', 'UNKNOWN', 'EXPORTED_ONLY'
    )),
  constraint schedule_update_read_back_status_values
    check (read_back_status in ('NOT_ATTEMPTED', 'MATCHED', 'MISMATCH', 'UNKNOWN')),
  constraint schedule_update_external_attempt_state_values
    check (external_attempt_state in ('IN_FLIGHT', 'RESULT_RECORDED')),
  constraint schedule_update_read_back_match_evidence
    check (read_back_status <> 'MATCHED'
      or (read_back_source_revision is not null
        and read_back_artifact_ref is not null
        and char_length(read_back_source_revision) > 0
        and char_length(read_back_artifact_ref) > 0)),
  constraint schedule_update_adoption_fact_values
    check (adoption_fact in ('NOT_ADOPTED', 'ADOPTED', 'UNKNOWN')),
  constraint schedule_update_adopted_evidence
    check (state <> 'ADOPTED'
      or (adoption_fact = 'ADOPTED'
        and revision_check_enforced
        and read_back_status = 'MATCHED'
        and source_revision_after is not null
        and artifact_ref is not null
        and char_length(source_revision_after) > 0
        and char_length(artifact_ref) > 0
        and source_revision_after = read_back_source_revision
        and artifact_ref = read_back_artifact_ref)),
  constraint schedule_update_result_mappings_array
    check (jsonb_typeof(result_mappings) = 'array')
);

-- D05: 同じ案件で正式採用する計画は最大1つ。後続の変更操作は別契約で確認する。
create unique index schedule_update_one_adopted_per_case
  on schedule_update (case_id)
  where state = 'ADOPTED';

create index schedule_update_case_created_idx
  on schedule_update (case_id, created_at);
