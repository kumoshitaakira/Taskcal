# src/application

**担当A** — use case、状態遷移の進行制御、取引境界（RFC-012 §3.1）。

ドメイン規則・adapter・画面から分けて、「どの手順を取引の中でやるか」をここで決める。

## use case

| ファイル | 内容 | 主に守る条件 |
|---|---|---|
| `create-absence-case.ts` | 欠勤案件の作成 | D01・D02、Q04・Q05、D11 |
| `start-outreach.ts` | 同時個別打診を積む（送信はしない） | D10、A15、ADR-006 |
| `send-outbox.ts` | 通知待ちを1件送る（workerの1ステップ） | A11、未送信と配送失敗の区別 |
| `receive-inbound-event.ts` | 受信の永続化と受信順の採番 | A12、A15 |
| `interpret-reply.ts` | 返信の解釈と承諾の生成 | A12、D03・D04、Q03〜Q05、Q09 |
| `interpret-pending.ts` | 未処理の返信を1件解釈する（workerの1ステップ） | 未設定なら何もしない |
| `roster-eligibility.ts` | **名簿だけの候補列挙。適格性検査ではない** | D01の名簿部分のみ |
| `case-view.ts` / `staff-view.ts` | 画面の読み取りモデル | ADR-017・ADR-022（状態を畳まない） |
| `offer-message.ts` | 打診・追加確認の本文 | RFC-011 §3 |
| `deps.ts` | 合成の根 | fake を本番経路へ入れない |

## 取引の中と外

| 手順 | 取引 | 理由 |
|---|---|---|
| 検査と永続化 | 中 | 一括性（D06）。読んでから書くまでに割り込ませない |
| メッセージ送信 | **外** | HTTP待ちの間ロックを持たない（RFC-010 §5） |
| モデル呼出し | **外** | 同上。同時に届いた他の返信を止めない |
| CSV生成・読戻し | **外** | ファイルとDBを一つの取引にできると仮定しない（RFC-010 §4） |

`withTransaction` は入れ子を検出して**外側の取引へ合流する**。一括性を守るための挙動だが、
副作用として「取引の内側から外部作用を呼んでも動いてしまう」。型では表せないので、
外部作用の入口で `assertOutsideTransaction()` を呼ぶ。`check:consistency` の
`MUST_BE_CALLED` が、この呼出しが残っていることを見る。

## 未実装の扱い

未実装の依存には「未実装を返す実装」を置く。模擬結果を返さない
（`UnconfiguredModelGateway` と同じ方針）。

- 適格性の再検査（可能時間・月次上限・重複）：`NOT_IMPLEMENTED` を投げる。
  検査していないものを通ったことにしない。
- 返信解釈：OrcaRouterが未設定なら `NOT_CONFIGURED`。worker は何もしない。
- 選定・正式採用：未実装。`/manager` と `/api/health` の「未実装」に出す。
- 送信結果の照合：未実装。`send-outbox.ts` は結果不明（`UNKNOWN`）の項目を再送しない。
  `claimNext` が `UNKNOWN` を取り出さないため、**照合の経路ができるまで止まったまま**に
  なる。失敗と断定しないための意図的な停止であり、静かに再送しないことが目的。
