# src/adapters/channel

**担当A** — 模擬メッセージ受信箱（RFC-012 §3.1、作業U07）。

`src/contracts/messaging-gateway.ts` の `MessagingGateway` を実装する。

| ファイル | 内容 |
|---|---|
| `mock-inbox.ts` | `send` / `getSendResult` / `verifyEndpoint` |
| `index.ts` | 組み立て。送信先の案件・打診を通知待ちから引く |

実在の連絡手段ではない。架空スタッフ役の画面（`/staff`）へメッセージを置くだけで、
本番の本人認証・配送とは区別する（RFC-009 §2）。

## 守る規則（RFC-011 §6）

- 受信イベントはモデル処理の**前に**永続化する。返信順は永続化した受信順で決める。
- 重複排除キーは provider・connectionId の範囲を含める（A15）。
- 受信本文で名乗った staffId を本人とみなさない。
- **宛先検査は `send` の内部で外部作用の直前に行う。** `verifyEndpoint` は画面表示・
  診断用で、送信の前提条件にしない（検査と送信を分けると、その間が競合窓になる）。
- 宛先不一致・連絡不許可・内容不一致は `SendRefused`（**未送信**）。
  `DeliveryState.FAILED`（送信を試みて失敗）と区別する。未送信のときは
  `message_delivery` の行を作らない。
- 送信は `operationId` ＋ `requestHash` で冪等。内容が変われば `CONFLICT` を返し送信しない。
- 拒否した操作を再実行しても、**同じ拒否**を返す。`UNKNOWN` へすり替えない（未送信の
  項目が「結果不明」として恒久的に止まるため）。
- 結果不明（`UNKNOWN`）を失敗として扱わず、`getSendResult` で照合するまで再実行しない。

## 送信先の解決

`send` は `command.operation.operationId` から通知待ち（`notification_outbox`）を引いて
案件・打診を決める。宛先（provider / connectionId / endpointKey）から逆引きしない。
同じ宛先が複数の案件に現れ得るため、逆引きはどの案件のメッセージか推測することになる。

通知待ちに積まずに `send` を呼ぶと `INVALID_INPUT` で止まる。送信は必ず outbox を通す。

## 障害の注入

`contact_endpoint.mock_fault_mode` で宛先ごとに指定する。**デモと受入試験のためのもので、
本番の経路ではない。**

| 値 | 送信の結果 |
|---|---|
| `NONE` | `ACCEPTED`。受信箱に現れる |
| `FAILED` | `FAILED`。送信を試みた記録は残るが受信箱には現れない。**自動では再送しない**（同じ内容の再送は保存済み結果を返すだけで結果が変わらない） |
| `UNKNOWN` | `UNKNOWN`。操作結果も `UNKNOWN`。再送せず照合へ回す |
| `LOOKUP_UNAVAILABLE` | 送信は `ACCEPTED`。**その宛先への**送信の `getSendResult` が `LOOKUP_UNAVAILABLE` を返す |

## `getSendResult` の「記録が無い」

模擬受信箱は自分の受信箱の権威なので、**記録が無い＝未送信**は確定した所見であり、
`QUEUED` を返す。照会不能（`LOOKUP_UNAVAILABLE`）とは別。外部SaaSの場合はこの前提が
成り立たないため、同じ扱いにしない。

## 受信

受信の永続化は `MessagingGateway` に含めない。案件内順序の採番を伴うため、repository
側の契約（`InboundEventRepository`）にしてある。

返信は `inReplyToMessageId`（送信したMessageの不変参照）で打診を引く。**宛先だけで
逆引きしない**——同じ相手へ過去の案件でも打診していると、古い打診への返信を現在の
案件の承諾として扱ってしまう（RFC-011 §3）。対象が引けても、宛先が打診時に固定した
ものと丸ごと一致しなければ本人とみなさない（A15）。

受け取った参照は**未検証の外部入力**として保存する（`in_reply_to_message_ref`、外部キー
無し）。外部キーを付けると、存在しないIDを送られただけで受信そのものを保存できず、
「対象を特定できない受信も捨てない」という契約を満たせない（ADR-008）。

関連する受入ケース：A11、A15。
