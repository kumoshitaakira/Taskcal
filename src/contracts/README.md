# src/contracts

API、イベント、モデル出力の共通契約。RFC-012 §3.1により**A・Bの共同所有**。

現状：**Day 1の下書き**。Bの確認を経て固定する。固定後の変更は、変更者でない側の
確認を必須とする（ADR-021）。

出典対応：

| ファイル               | 出典                                                  |
| ---------------------- | ----------------------------------------------------- |
| `case-state.ts`        | RFC-011 §5 の状態図、ADR-017                          |
| `outreach-state.ts`    | RFC-011 §2、ADR-013                                   |
| `schedule-update.ts`   | RFC-010 §6・§7、ADR-016、ADR-019                      |
| `operation.ts`         | ADR-006、RFC-009 D07                                  |
| `schedule-gateway.ts`  | RFC-010 §6、ADR-019                                   |
| `messaging-gateway.ts` | RFC-011 §6、ADR-019                                   |
| `model-output.ts`      | RFC-011 §3、ADR-004、ADR-014（対応文型の幅はQ09未決） |
| `errors.ts`            | 各契約の失敗表現                                      |

識別子と永続化するenum値は英語（AGENTS.md）。

## まだ契約に無いもの（Day 2着手前に決める）

この下書きには、以下がまだありません。「Day 1に固定した」と読まないでください。

| 不足 | 必要になる時点 | 関連 |
|---|---|---|
| `Commitment`（版付きの承諾、`supersedes`、選定可能な版は一つ） | 返信から承諾を作る時 | RFC-011 §4、D04 |
| `SelectionResult`（選んだ承諾のID・版、規則版、検査時の入力版） | 選定を実装する時 | RFC-009 §3 |
| 永続化した`ReplyInterpretation`（messageId、receivedSeq、案件版、callId の紐づけ） | A12を実装する時 | RFC-011 §4 |
| worker の lease / fence token | 同じイベントの二重処理を防ぐ時 | ADR-006 |

`schedule-gateway.ts` の `commitmentId` は、まだ定義の無い概念への文字列参照です。

`worker_heartbeat`（migration 0001）は生存確認だけで、二重処理を防ぐ仕組みではありません。
`worker_name` が主キーのため、同名workerが2本立っても upsert で上書きされ、`/api/health`
からは検出できません。worker を複数走らせる場合は lease を先に実装してください。
