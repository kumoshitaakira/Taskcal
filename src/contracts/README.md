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
| `model-output.ts`      | RFC-011 §3、ADR-004、ADR-014、Q09（2026-09-21確定） |
| `errors.ts`            | 各契約の失敗表現                                      |

識別子と永続化するenum値は英語（AGENTS.md）。

## 遷移には条件がある

矢印だけを見て状態を動かさないこと。次の関数を通す。

| 関数 | 守る規則 |
|---|---|
| `resolveReconcile`（schedule-update） | 照合の証拠なしに照合待ちを解消しない。「照会が取れなかった」を「未採用」と読み替えない |
| `resolveReconcileStall`（case-state） | 照会経路が使えるうちは状態を動かさない。使えなくなったら成否不明のまま要対応へ |
| `canResumeReporting`（case-state） | 採用済みと確認でき、かつ正式版の読戻しが一致した場合だけ通知処理へ戻す |
| `resolvePreparingStop`（case-state） | 期限を検知しただけで引き継がない。採用結果を先に確定させる |
| `resolveCaseReconcile`（case-state） | 未採用と**確認**できたときだけ調整中へ戻す。確認せず戻すと二重採用になる |

`resolveReconcile`（ScheduleUpdate側）と `resolveCaseReconcile`（案件側）は対になる。
同じ照合結果から両方の状態を決めること。片方だけ動かさない。

`ScheduleGateway` の4操作（`loadSchedule` / `applyUpdate` / `getUpdateResult` /
`readBack`）はすべて `connectionId` を取る。`loadSchedule` は正式版参照も取り、
初回取込み以外では必ず渡す（RFC-010 §2、A01、D11）。

`HANDED_OFF` は「自動調整を終了し、人へ対応を引き継いだ」であり、**未確定を意味しない**
（[ADR-022](../../docs/adr/ADR-022-handoff-and-outcome-retention.md)）。採用事実
（`AdoptionFact`：未採用／採用済み／成否不明）は案件状態と別に保持し、画面でも区別して
表示する。案件状態から採用可否を推定しない。

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
