# src/adapters/db/migrations

**担当B（作成）／A（承認）** — RFC-012 §3.1。

番号付きSQL migration。`0001_...sql` のように連番＋説明で命名する。

規則：

- 1ファイル = 1トランザクション。runner（`scripts/migrate.ts`）が `BEGIN`/`COMMIT` を
  付けるので、ファイル内に書かない。
- 適用済みのファイルは内容を変更しない。runnerが内容hashの変更を検出して停止する。
  変更したい場合は新しい番号のmigrationを追加する。
- 勤務ID・staffId・案件ID・操作ID・採用解釈・更新後CSV参照を欠落させない（RFC-009 §8）。
- 業務レコードはUUID、`created_at` を持つ。外部入力の店舗IDを信用せず、認証
  コンテキストから決めた値と照合する（ADR-008）。
- 同じ操作IDで異なる内容を拒否できる制約を置く（ADR-006 / RFC-009 D07）。

## 番号の割当

| 帯 | 担当 | 内容 |
|---|---|---|
| `0001` | A | worker基盤（`worker_heartbeat`） |
| `0002`–`0019` | A | 案件・打診・受信・解釈・承諾・選定・操作結果・outbox・予算・モデル呼出し |
| `0020`– | B | CSV由来の派生表、索引の追加、受入試験用 |

**帯を分ける理由**：`scripts/migrate.ts` は適用順の逆転を拒否する。適用済みの最大番号
より小さい未適用ファイルがあると停止する。2人が交互に番号を取ると、片方が先に適用した
時点でもう片方のmigrationが永久に適用できなくなる。

これは RFC-012 §3.1 の所有表（migrations は「B作成・A承認」）に対する**運用上の例外**
であり、所有の変更ではない。Day 2 に A の use case が先行するため番号帯を分けた。
ADR-021 に従い B の確認を得ること。

## テーブルと守る不変条件

| migration | テーブル | 主に守る条件 |
|---|---|---|
| `0002` | `store` / `staff` / `contact_endpoint` / `schedule` / `shift_assignment` / `authoritative_schedule_ref` | 勤務の重複禁止（ADR-006）、承諾1件につき勤務1件（D05）、正式版参照（D11） |
| `0003` | `operation_result` | 同じ操作IDで異なる内容を拒否（D07） |
| `0004` | `absence_case` / `case_processing_event` | 稼働中の重複案件を作らない（D02）、引き継ぎは理由と対（ADR-022） |
| `0005` | `outreach` / `outreach_message` / `message_delivery` / `notification_outbox` / `mock_inbox_item` | 未送信（REFUSED）と配送失敗（FAILED）の区別（RFC-011 §6） |
| `0006` | `inbound_event` / `reply_interpretation` | 接続範囲を含む重複排除（A15）、案件内の受信順（A12） |
| `0007` | `commitment` / `selection_result` / `selection_item` / `schedule_update` | 選定可能な版は一つ（D04）、二重採用の禁止（D05） |
| `0008` | `budget_reservation` / `model_call` | 予約と精算の対（RFC-004 §7）、結果不明を費用0にしない |
| `0009` | `inbound_event.message_id` | 受信とMessageの対応 |
| `0010` | `inbound_event.interpretation_block` / 返信対象の参照 | 解釈できない受信を取り出しから外す、返信対象の参照（RFC-011 §3） |
| `0011` | `inbound_event.in_reply_to_message_ref` | 返信対象の参照を**未検証の外部入力**として持つ。外部キーを付けると、存在しないIDを送られただけで受信を保存できない（ADR-008） |

`0002` の `create extension btree_gist` は、拡張を作れない環境では失敗する。その場合に
重複禁止の制約を落とすなら、落とした事実を README の「現時点で動かないもの」へ記録する
こと（黙って外さない）。

CSV原本の取込み・正規化（担当B、`src/adapters/csv/`）は未実装。`0002` はその結果を置く
場所を作るだけで、CSVを読む経路を実装したことを意味しない。開発用の架空データは
`npm run seed:dev` が入れる。

`schema_migrations` テーブルはrunnerが自動で作る。ここに書かない。
