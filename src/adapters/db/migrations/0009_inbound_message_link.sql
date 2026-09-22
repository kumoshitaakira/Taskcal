-- 0009: 受信イベントと Message の対応。担当A（Day 2）。
--
-- 0006 では受信イベントと Message を別々に保存していたため、重複受信を返すときに
-- 本文で Message を引き直す必要があった。本文が同じ返信（「大丈夫です」など）が
-- 複数あると別のMessageを返しかねないので、対応を列で持つ。

alter table inbound_event
  add column message_id uuid references outreach_message (message_id);

-- 案件へ結び付いた受信は Message も持つ。結び付かない受信は持たない。
alter table inbound_event
  add constraint inbound_event_message_pair check ((case_id is null) = (message_id is null));
