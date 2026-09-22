-- 0010: 解釈できない受信を、取り出し対象から外す。担当A（Day 2）。
--
-- 解釈が失敗しても受信順（outreach.last_applied_seq）は進まない。これは正しい
-- （適用していないものを適用済みにしない：A12）。しかし取り出しの条件が受信順だけ
-- だと、同じ受信を毎ティック選び直し、後ろに並んだ他のスタッフの返信を永久に
-- 処理できない。
--
-- 「適用していない」と「これ以上自動では進められない」を別の列で持つ。

alter table inbound_event
  add column interpretation_block text,
  add column blocked_at timestamptz;

-- 理由の無い保留を作らない。いつ止まったかも残す。
alter table inbound_event
  add constraint inbound_event_block_pair
  check ((interpretation_block is null) = (blocked_at is null));

-- 取り出しの走査用。保留していないものだけを見る。
create index inbound_event_interpretable
  on inbound_event (received_seq)
  where interpretation_block is null and case_id is not null;

-- RFC-011 §3：返信対象を不変のMessage参照から特定できるようにする。
-- 宛先だけで打診を逆引きすると、同じ相手への過去の打診と現在の打診を区別できない。
alter table inbound_event
  add column in_reply_to_message_id uuid references outreach_message (message_id);
