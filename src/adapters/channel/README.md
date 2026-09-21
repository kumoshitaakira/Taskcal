# src/adapters/channel

**担当A** — 模擬メッセージ受信箱（作業U07）。未実装。

`src/contracts/messaging-gateway.ts` の `MessagingGateway` を実装する。
MVPは模擬返信契約だけを実装し、LINE等の本番接続は行わない（RFC-011 §6）。

守る規則：

- 受信イベントは、モデル処理の前に永続化する。返信順は永続化した受信順で決める。
- 重複排除キーは provider・connectionId の範囲を含める（A15）。
- 受信本文で名乗った staffId を本人とみなさない。
- **宛先の検査は `send` の内部で、外部作用の直前に行う。** `verifyEndpoint` を先に
  呼んで `MATCHES` を得ても、その後に宛先の版や連絡許可が変わり得る。検査と送信を
  別操作にすると、その間が競合窓になり旧宛先へ送ってしまう（A15、RFC-011 §6）。
  `verifyEndpoint` は画面表示・診断のための照会であり、送信の前提条件ではない。
- 宛先不一致・連絡不許可・内容不一致は `SendRefused` を返す。**いずれも送信して
  いない。** 配送の失敗（`DeliveryState.FAILED`）と区別する。
- 送信は `operationId` ＋ `requestHash` で冪等にする。同じキーで内容（宛先・種別・
  本文）が変われば `CONFLICT` を返し、**送信しない**。hashが無いと、変更後の通知を
  `REPLAY` として握り潰すか、別内容を送るかの二択になる（ADR-006 / D07）。
- 結果不明（`UNKNOWN`）を失敗として扱わない。`getSendResult` で照合するまで
  同じ送信を再実行しない。
