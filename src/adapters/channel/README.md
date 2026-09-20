# src/adapters/channel

**担当A** — 模擬メッセージ受信箱（作業U07）。未実装。

`src/contracts/messaging-gateway.ts` の `MessagingGateway` を実装する。
MVPは模擬返信契約だけを実装し、LINE等の本番接続は行わない（RFC-011 §6）。

守る規則：

- 受信イベントは、モデル処理の前に永続化する。返信順は永続化した受信順で決める。
- 重複排除キーは provider・connectionId の範囲を含める（A15）。
- 受信本文で名乗った staffId を本人とみなさない。
- 宛先の同一性を検査する。途中の宛先変更で旧打診を別人へ送らない。
