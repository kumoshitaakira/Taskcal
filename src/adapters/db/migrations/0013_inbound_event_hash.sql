-- 0013: 受信イベントの内容ハッシュ。担当A（Day 2）。
--
-- D07（ADR-006）：同じIDで異なる内容は拒否し、同じ内容は保存済み結果を返す。
-- 受信の重複排除は provider・connectionId・eventId だけを見ていたため、同じIDで
-- 本文や送信元が違うイベントを送られても DUPLICATE として保存済みの事実を返し、
-- 返した内容と保存済みの内容が食い違い得た。
--
-- 内容のハッシュを保存して照合する。送信操作（operation_result）と同じ扱いにする。

alter table inbound_event
  add column event_hash text;

alter table inbound_event
  add constraint inbound_event_hash_format
  check (event_hash is null or event_hash ~ '^[0-9a-f]{64}$');

-- 既存行にはハッシュが無い。既存の受信を「内容不明」として残し、照合は
-- ハッシュを持つ行に対してだけ行う（後から遡って偽のハッシュを作らない）。
comment on column inbound_event.event_hash is
  '受信内容のハッシュ。0013より前に保存した行はnull（当時は記録していない）。';
