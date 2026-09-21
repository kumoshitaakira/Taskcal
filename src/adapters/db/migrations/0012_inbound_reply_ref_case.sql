-- 0012: 返信先の参照の検査を、APIが受け取る値域へ揃える。担当A（Day 2）。
--
-- 0011 の検査は小文字のUUIDしか通さなかった。入口の `z.uuid()` は大文字・混在も
-- 受理するため、大文字のUUIDを送られると保存時に 23514 で落ち、受信そのものが
-- ロールバックされる。「対象を特定できない受信も捨てない」という契約（RFC-011 §6、
-- A15）を、値の書き方の違いで破っていた。
--
-- **DBが値域を決める側にならないようにする。** 入口が受理する形はDBも受け取る。
-- そのうえで保存する値はrepositoryが小文字へ正規化し、比較の揺れを作らない
-- （担当BのCSV取込みが `z.uuid().transform(toLowerCase)` でやっているのと同じ方針）。

alter table inbound_event
  drop constraint inbound_event_reply_ref_format;

alter table inbound_event
  add constraint inbound_event_reply_ref_format
  check (
    in_reply_to_message_ref is null
    or in_reply_to_message_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
