-- 0006: 受信イベントと返信解釈。担当A（Day 2）。
--
-- RFC-011 §4：受信イベントはモデル処理の**前に**永続化する。返信順はモデル処理の
-- 完了時刻ではなく、永続化した受信順で決める。遅れて返ったモデル結果で新しい承諾を
-- 過去の状態へ戻さない（A12）。

create table inbound_event (
  inbound_event_id uuid primary key,
  -- 打診と結び付けられなかった受信も捨てずに残す。本人と確認できない返信の記録が要る。
  case_id uuid references absence_case (case_id),
  outreach_id uuid references outreach (outreach_id),
  -- 案件へ結び付いた受信だけが順序を持つ。
  received_seq bigint,
  provider text not null,
  connection_id text not null,
  provider_event_id text not null,
  -- 送信側の時刻と、こちらの受信時刻を分ける（RFC-011 §4）。
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  from_provider text not null,
  from_connection_id text not null,
  from_endpoint_key text not null,
  from_endpoint_version integer not null,
  body text,
  -- 経路の検証結果。**本人確認ではない**（RFC-011 §6）。
  channel_verified boolean not null,
  -- 本人性の判定。受信本文で名乗った staffId を本人とみなさない。
  sender_identity text not null check (
    sender_identity in ('VERIFIED_OUTREACH_TARGET', 'UNMATCHED', 'UNVERIFIABLE')
  ),
  created_at timestamptz not null default now(),
  constraint inbound_event_seq_pair check ((case_id is null) = (received_seq is null)),
  -- 案件内の受信順は欠番も重複も許さない。
  constraint inbound_event_case_seq unique (case_id, received_seq),
  -- A15：重複排除キーは provider・connectionId の範囲を含める。
  -- **case_id を含めない。** 含めると同じ provider イベントが別案件で二重に入る。
  constraint inbound_event_dedupe unique (provider, connection_id, provider_event_id)
);

create index inbound_event_outreach on inbound_event (outreach_id, received_seq);

-- 版付きの解釈（RFC-009 §3）。採用した解釈を追跡できるようにする。
create table reply_interpretation (
  interpretation_id uuid primary key,
  case_id uuid not null references absence_case (case_id),
  message_id uuid not null references outreach_message (message_id),
  inbound_event_id uuid not null references inbound_event (inbound_event_id),
  -- A12：どの受信順に対する解釈か。時刻ではなくこれで新旧を決める。
  received_seq bigint not null,
  -- 解釈を作ったときの案件版。前提が変わっていたら適用しない（D08）。
  case_version integer not null,
  -- モデル呼出しの安定ID。0008 の model_call と対応する。
  request_id text not null,
  output jsonb not null,
  -- 連絡先をマスクした本文。原文をそのまま残さない（ADR-008）。
  masked_reply_text text not null,
  -- 案件へ適用したか。古い結果は保存するが適用しない（A12）。
  applied text not null check (
    applied in ('APPLIED', 'DISCARDED_STALE', 'REJECTED_BY_CHECK')
  ),
  created_at timestamptz not null default now(),
  -- 同じ受信・同じ呼出しの解釈を二重に保存しない。
  constraint reply_interpretation_unique unique (message_id, request_id)
);

create index reply_interpretation_case on reply_interpretation (case_id, received_seq);
