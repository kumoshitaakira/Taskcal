-- 0011: 返信先の参照を「外部から受け取った未検証の値」として持つ。担当A（Day 2）。
--
-- 0010 では `in_reply_to_message_id` に外部キーを付けていた。しかしこの値は
-- **外部から受け取った入力**で、こちらのデータではない。存在しないUUIDを送られると
-- 保存自体が落ち、「対象を特定できない受信も捨てずに残す」という契約（RFC-011 §6、
-- A15）を満たせず、APIも500になる。外部入力を信用しない（ADR-008）。
--
-- 受け取った参照（未検証）と、照合できた打診（`outreach_id`）を分けて持つ。
-- 本人と確認できたかは `sender_identity` が表す。

alter table inbound_event
  drop constraint inbound_event_in_reply_to_message_id_fkey;

alter table inbound_event
  rename column in_reply_to_message_id to in_reply_to_message_ref;

alter table inbound_event
  alter column in_reply_to_message_ref type text using in_reply_to_message_ref::text;

-- 形式だけは検査する。UUID以外は受け取らない（APIのschemaと二重に見る）。
alter table inbound_event
  add constraint inbound_event_reply_ref_format
  check (
    in_reply_to_message_ref is null
    or in_reply_to_message_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
