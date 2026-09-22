-- 0005: 相手別の打診、メッセージ、配送、通知待ち、模擬受信箱。担当A（Day 2）。
--
-- RFC-011 §2・§6。一人の確認失敗で案件全体を閉じない（A11）。
-- Outreach.status だけで全配送結果を代表させない。送信操作ごとに配送状態を持つ。

create table outreach (
  outreach_id uuid primary key,
  case_id uuid not null references absence_case (case_id),
  staff_id uuid not null references staff (staff_id),
  -- 打診時点で固定した宛先。途中の宛先変更で旧打診を別人へ送らない（RFC-011 §6、A15）。
  endpoint_provider text not null,
  endpoint_connection_id text not null,
  endpoint_key text not null,
  endpoint_version integer not null,
  offered_start_at timestamptz not null,
  offered_end_at timestamptz not null,
  state text not null check (
    state in (
      'PENDING_SEND', 'SENT', 'AWAITING_REPLY', 'CLARIFYING', 'ANSWERED', 'EXPIRED', 'CLOSED'
    )
  ),
  version integer not null default 1,
  -- A12：この打診について解釈を適用した最後の受信順。
  -- これより小さい受信の解釈は、遅れて返っても適用しない。
  last_applied_seq bigint not null default 0,
  -- モデルへ渡す匿名の参照。実名・連絡先をプロンプトへ入れない（ADR-008）。
  anonymous_staff_ref text not null,
  created_at timestamptz not null default now(),
  constraint outreach_range check (offered_start_at < offered_end_at),
  -- 同じ案件で同じ相手へ二重に打診しない。
  constraint outreach_case_staff unique (case_id, staff_id)
);

create index outreach_case on outreach (case_id);
create index outreach_endpoint
  on outreach (endpoint_provider, endpoint_connection_id, endpoint_key);

-- 本文は不変。配送状態は別（RFC-011 §6）。
create table outreach_message (
  message_id uuid primary key,
  case_id uuid not null references absence_case (case_id),
  outreach_id uuid references outreach (outreach_id),
  direction text not null check (direction in ('OUTBOUND', 'INBOUND')),
  kind text check (
    kind in ('INITIAL_OFFER', 'CLARIFICATION', 'CONFIRMATION', 'NOT_SELECTED', 'CASE_CLOSED')
  ),
  body text not null,
  created_at timestamptz not null default now(),
  -- 送信は種別を持ち、受信は持たない。
  constraint outreach_message_kind_pair check ((direction = 'OUTBOUND') = (kind is not null))
);

create index outreach_message_case on outreach_message (case_id, created_at);

-- 1回の送信操作の配送状態。UNKNOWN を FAILED へ丸めない（AGENTS.md）。
create table message_delivery (
  operation_id text primary key references operation_result (operation_id),
  message_id uuid not null references outreach_message (message_id),
  connection_id text not null,
  state text not null check (state in ('QUEUED', 'ACCEPTED', 'FAILED', 'UNKNOWN')),
  provider_message_id text,
  created_at timestamptz not null default now()
);

-- 送信待ち。取引の中で積み、送信そのものは取引の外で行う（外部API待ちを取引に入れない）。
create table notification_outbox (
  outbox_id uuid primary key,
  case_id uuid not null references absence_case (case_id),
  outreach_id uuid references outreach (outreach_id),
  -- Q07：確定通知だけでなく、非選定通知・募集終了通知も業務完了の対象。
  kind text not null check (
    kind in ('INITIAL_OFFER', 'CLARIFICATION', 'CONFIRMATION', 'NOT_SELECTED', 'CASE_CLOSED')
  ),
  body text not null,
  -- 呼出し元が永続化した安定キー。再試行で作り直さない（ADR-006）。
  operation_id text not null unique,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  connection_id text not null,
  -- REFUSED は**未送信**。FAILED（送信を試みて失敗）と同じ欄に畳まない（RFC-011 §6）。
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENT', 'FAILED', 'UNKNOWN', 'REFUSED')),
  refusal text check (refusal in ('ENDPOINT_CHANGED', 'NOT_PERMITTED', 'CONFLICT')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  -- 同じ項目の二重送信を防ぐ最小の lease。worker の fence token はまだ無い。
  leased_until timestamptz,
  lease_token uuid,
  message_id uuid references outreach_message (message_id),
  created_at timestamptz not null default now(),
  constraint outbox_refusal_pair check ((status = 'REFUSED') = (refusal is not null))
);

-- 取り出し対象の走査用。UNKNOWN は取り出さないため索引にも含めない。
create index notification_outbox_claimable
  on notification_outbox (next_attempt_at)
  where status in ('PENDING', 'FAILED');

create index notification_outbox_case on notification_outbox (case_id, created_at);

-- スタッフ役の画面に出す模擬受信箱。実在の連絡手段ではない（RFC-009 §2）。
create table mock_inbox_item (
  inbox_item_id uuid primary key,
  message_id uuid not null unique references outreach_message (message_id),
  staff_id uuid not null references staff (staff_id),
  outreach_id uuid references outreach (outreach_id),
  body text not null,
  created_at timestamptz not null default now()
);

create index mock_inbox_item_staff on mock_inbox_item (staff_id, created_at);
