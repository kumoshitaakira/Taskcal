# src/contracts

API、イベント、モデル出力の共通契約。RFC-012 §3.1により**A・Bの共同所有**。

現状：Day 1の下書きに、Day 2（担当A）で承諾・選定結果・打診の遷移・永続化の口を
足したもの。Bの確認を経て固定する。固定後の変更は、変更者でない側の確認を必須と
する（ADR-021）。

出典対応：

| ファイル               | 出典                                                  |
| ---------------------- | ----------------------------------------------------- |
| `case-state.ts`        | RFC-011 §5 の状態図、ADR-017                          |
| `commitment.ts`        | RFC-011 §3・§4、RFC-009 D03・D04、ADR-014、Q09        |
| `selection.ts`         | RFC-009 §3・§6、Q02、Q06                              |
| `repository.ts`        | RFC-010 §4 手順6、RFC-011 §4、ADR-006、D05・D06       |
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
| `isSelectableCommitment`（commitment） | `status === "ACTIVE"` だけで選定しない。未処理の新しい返信・置き換え・期限も見る（D04、A05）。**選定時と正式採用の直前の両方で通す** |
| `resolveOutreachAfterSend`（outreach-state） | 配送状態を打診状態へそのまま写さない。届いたと確認できるまで送信待ちに留める（A11） |
| `resolveOutreachAfterInbound`（outreach-state） | 本人と確認できない受信で状態を動かさない。動かさないことと受信を捨てることは別（A15） |

`resolveReconcile`（ScheduleUpdate側）と `resolveCaseReconcile`（案件側）は対になる。
同じ照合結果から両方の状態を決めること。片方だけ動かさない。

`ScheduleGateway` の4操作（`loadSchedule` / `applyUpdate` / `getUpdateResult` /
`readBack`）はすべて `connectionId` を取る。`loadSchedule` は正式版参照も取り、
初回取込み以外では必ず渡す（RFC-010 §2、A01、D11）。

`ScheduleGateway` の例外は原則「成否不明」で、`NOT_APPLIED` や失敗と等価ではない。
**例外はふたつだけ**で、`NOT_IMPLEMENTED` と `NOT_CONFIGURED` は「adapter が外部作用の
**前に**断った」を意味する。adapter はこの2つを、外部へ要求を出す前にだけ投げること。

`HANDED_OFF` は「自動調整を終了し、人へ対応を引き継いだ」であり、**未確定を意味しない**
（[ADR-022](../../docs/adr/ADR-022-handoff-and-outcome-retention.md)）。採用事実
（`AdoptionFact`：未採用／採用済み／成否不明）は案件状態と別に保持し、画面でも区別して
表示する。案件状態から採用可否を推定しない。

## 取引境界は application 側が決める

`repository.ts` の全ての操作が `tx: TxHandle` を取ります。repository が自分で取引を
開くと、正式採用の一括保存（正式版参照・内部勤務表・採用済み計画・案件の確定事実・
操作結果・通知待ちを同じ取引で保存する）が黙って複数の取引へ割れ、一部だけが正式勤務
として残ります（RFC-010 §4 手順6、D06）。

`TxHandle` を `object` にしてあるのは、`src/contracts/` を `pg` へ依存させないためです。
実体は `src/adapters/db/transaction.ts` の `Tx` で、`withTransaction` が渡します。

## まだ契約に無いもの

| 不足 | 必要になる時点 | 関連 |
|---|---|---|
| worker の lease / fence token | 同じイベントの二重処理を防ぐ時 | ADR-006 |
| 本人の可能時間の入力 | 可能時間で候補を絞る時（いまは承諾した区間で代用） | Q15、A17 |
| 採用済み勤務の取消・変更 | 確定後の変更を扱う時（D10：別の変更操作にする） | RFC-009 D10 |

`EligibilityChecker.recheck` は同期interfaceで、repositoryも取引ハンドルも取りません。
実装側が口の中でDBやGatewayを引く形にすると、外部待ちを取引の中へ持ち込みます
（RFC-010 §5）。そのため**必要な入力は呼出し側が渡します**。

**2026-09-22（Q15・担当B承認済み）：合流しました。** `EligibilityRecheckInput` へ
`businessDate` / `absentStaffId` / `monthlySchedule` / `staffProfiles` を足し、
`src/application/eligibility-recheck.ts` が担当Bの `evaluateCandidateEligibility`
（`src/domain/interval/`）を通します。`recheck` は同期のままです。

`selection.ts` は `MonthlyScheduleSnapshot` と `StaffProfile` を **`@/domain/interval` から
型だけ取り込みます**（`import type`）。実行時の依存は増えません。契約側で同じ形を
書き写すと、片方だけが変わったときに黙って食い違うためです。

**可能時間は固定デモ日のみ検査します。** 可能時間表の永続化schemaが未承認のため、
固定fixtureの可能時間を渡し、対象外の日は正式採用を止めます。実際に効くのは在籍・店舗・
職種・本人除外・勤務の重複・月次上限です。READMEの「動かないもの」に残しています。

時刻の形式は境界でそろえます。永続層は `Date.toISOString()`（UTC）、担当Bの規則は
`YYYY-MM-DDTHH:MM:00+09:00`（Asia/Tokyo固定）です。`toJstFixedFormat` が写し、
秒未満を含む値は**黙って丸めず**範囲外として断ります。オフセットの無い日時も断ります
——`Date.parse` がサーバのタイムゾーンで解釈し、壁時計の時刻が実行環境で変わるためです。
変換は **+09:00 固定**で、店舗の `timezone` で計算してはいません。店舗が別のタイムゾーン
なら `MVP_TIMEZONE` の検査が拒否します。

再検査へ渡すのは**判定に要る行だけ**です。月次上限も重複も可能時間も「その本人の、その月の」
勤務しか見ないため、無関係な行まで渡すと、他人の日跨ぎ勤務が1行あるだけで案件全体が
未採用確定に落ちます。あわせて `LoadedSchedule.requestedRange` が対象月を覆っているかを
検査します。`completeness` は「取得を試みた範囲の中で揃っている」という意味でしかなく、
範囲が狭いまま信じると取得していない日を0分として数えます（Q06 / A09）。

`schedule-gateway.ts` の `commitmentId` は `commitment.ts` の `Commitment.commitmentId`
を指します。`selection.ts` の `SelectionPlanner` と `EligibilityChecker` は
`src/domain/selection/` で固定CSVの正常系へ接続しました。入力版や可能時間を確認できない
場合は、検査を省略せず正式採用を止めます。
`src/domain/interval/index.ts` の `evaluateCandidateEligibility` は
`monthlySchedule: MonthlyScheduleSnapshot` を使う。今回の固定CSV経路では
`EligibilityChecker.recheck` から呼び、最新の月内勤務を渡す。

固定CSV経路では下記の形で接続した。ADR-021により、変更者でない側の確認が要る。

### 固定CSV正常系での最小契約変更案（A・B共同確認待ち）

`SelectionInputs.monthlyRevision` に、対象月の全日別正式版参照、勤務行、スタッフ条件の
内容hashを選定時に保存する。正式採用取引内で同じDB範囲を読み直して照合する。
`EligibilityRecheckInput` に `monthlySchedule`、`staffProfiles`、`absentStaffId` を渡し、
既存の `evaluateCandidateEligibility` で可能時間・重複・月次上限を再検査する。
`SelectionInputs.baseArtifactRef` と `ApplyUpdateCommand.baseArtifactRef` は現行正式版成果物を
更新元として指定し、操作のrequestHashにも含める。値が確認できない場合は採用を止める。
これらは今回の固定fixture向け実装であり、Q14の共同確認による業務契約の確定ではない。
既存の `selection_result` テーブルには `monthly_revision` と `base_artifact_ref` が無い。
採用準備中に再起動した場合はこの入力版を復元できず、正式採用を止める。A・B確認後、
両列のmigration、repositoryの保存・読戻し、再開試験が必要。未承認draftは使用しない。

`schedule-gateway.ts` の `commitmentId` は `commitment.ts` の `Commitment.commitmentId`
を指します。`selection.ts` の `SelectionPlanner` と `EligibilityChecker` は
`src/domain/selection/` で固定CSVの正常系へ接続しました。入力版や可能時間を確認できない
場合は、検査を省略せず正式採用を止めます。

`worker_heartbeat`（migration 0001）は生存確認だけで、二重処理を防ぐ仕組みではありません。
`worker_name` が主キーのため、同名workerが2本立っても upsert で上書きされ、`/api/health`
からは検出できません。worker を複数走らせる場合は lease を先に実装してください。
