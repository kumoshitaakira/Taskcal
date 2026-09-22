-- 0008: 予算台帳とモデル呼出し記録。担当A（Day 2）。
--
-- RFC-004 §7 / ADR-007 / D12：金額予算が未設定なら有料呼出しを始めない。呼出しの前に
-- 回数・費用を予約し、後で精算する。同時返信で複数の推論が起きるため予約を共有する。
--
-- src/adapters/orca/budget.ts の BudgetLedger / ModelCallStore の保存先。

create table budget_reservation (
  -- 呼出し元が永続化した安定ID。再試行で採番し直さない。
  request_id text primary key,
  case_id uuid not null,
  run_id text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  -- 予約額。USDの整数micro単位（RFC-004 §7）。円換算は表示時のみ。
  estimated_micro_usd bigint not null check (estimated_micro_usd > 0),
  -- 精算額。**結果不明でも0にしない。** 予約額をそのまま費用として残す
  -- （AGENTS.md：タイムアウトや結果不明を費用0として記録しない）。
  settled_micro_usd bigint check (settled_micro_usd >= 0),
  cost_kind text check (cost_kind in ('MEASURED', 'ESTIMATED', 'UNKNOWN_CHARGE')),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint budget_reservation_settled_pair check ((settled_at is null) = (cost_kind is null))
);

-- 上限判定は案件単位と実行単位の合計を取る。未精算は予約額で数える。
create index budget_reservation_case on budget_reservation (case_id);
create index budget_reservation_run on budget_reservation (run_id);

create table model_call (
  request_id text primary key,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  case_id uuid not null,
  run_id text not null,
  step text not null check (step in ('INTERPRET_REPLY', 'REPAIR', 'SELECT_ACTION')),
  -- SCHEMA_INVALID と UNKNOWN も確定した記録として保存する。保存しないと、
  -- 再試行のたびに課金され得る呼出しを繰り返す。
  outcome text not null check (outcome in ('VALID', 'SCHEMA_INVALID', 'UNKNOWN')),
  output jsonb,
  -- 実測・推定・取得不能の区別を含む使用量（RFC-004 §8）。
  usage jsonb not null,
  masked_reply_text text not null,
  created_at timestamptz not null default now(),
  constraint model_call_output_pair check ((outcome = 'VALID') = (output is not null))
);

create index model_call_case on model_call (case_id, created_at);
