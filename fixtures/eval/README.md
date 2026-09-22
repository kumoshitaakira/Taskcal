# 決定的な受入fixture

このディレクトリは、A02、A03、A04、A07、A08、A14、A15、A18を再現するための
入力と期待結果を固定する。これはアプリケーション、DB、Gateway、模擬受信箱を接続した
受入実行結果ではない。`tests/unit/eval-fixtures.test.ts`は、fixtureの構造、既存契約の
値、操作ハッシュを検査するだけであり、A01〜A18の合格を主張しない。

## 形式

各JSONは一つの受入ケースを表し、`scenarios`に一つ以上の反例を持つ。

- `input`：案件状態、最後に確認できた正式版、固定した更新／送信内容。
- `operations`：実行する前に固定する`operationId`、`requestPayload`、`requestHash`。
  配列の順序に意味がある更新内容は、既存契約どおり安定ID順で記載する。
- `observedUpdateResult`：実行結果または照会結果のfixture上の証拠。`operationId`・
  `connectionId`・結果種別を対応付けるが、Gatewayの新しい業務契約を追加するものではない。
- `expected`：既存契約で表せる終状態、採用事実、最後に確認できた正式版、結果種別。
- `forbiddenExternalEffects`：このfixtureで発生してはいけない外部作用。これは評価用の
  語彙であり、`src/contracts`へ新しい業務enumを追加するものではない。
- `applicationAcceptance`：結合受入の状態と、必要な結合条件。現在は全シナリオを
  `UNEXECUTED`とする。fixture検証テストの成功をこの値へ反映しない。

`sourceRevision`はRFC-010の外部版／不変管理版を表すfixture値で、ハッシュ形式を新たに
要求しない。`UNKNOWN`のシナリオで保持する版は「最後に確認できた版」であり、外部作用が
無かったという証明ではない。

`provider`と`endpointVersion`は、RFC-011の`ContactEndpointRef`が必要なA15の送信・受信
fixtureにだけ記載する。ScheduleGatewayの契約にはproviderやendpointVersionがないため、
CSV更新fixtureへ独自のフィールドを足していない。

A15の`receivedSeqByEvent`は、受信イベントを永続化した後に案件内で採番される期待値である。
入力イベント自体の`receivedAt`やモデル処理完了時刻を返信順の根拠にしない。

## 受入対応表

| ケース | fixture | 結合前に固定する反例 | 決定的に確認する境界 | 結合受入 |
| --- | --- | --- | --- | --- |
| A02 | `A02-stop-before-adoption.json` | 作業用CSVはできたが店長停止 | `PREPARED`は正式採用ではなく、`CANCELLED`かつ`NOT_ADOPTED` | 未実行：案件停止と一括採用transaction |
| A03 | `A03-adoption-response-loss.json` | 正式採用直後に応答が失われる | `UNKNOWN`を未採用へ丸めず、重複作成せず引き継ぐ | 未実行：応答喪失後の照合・再起動 |
| A04 | `A04-old-revision-race.json` | 同じ旧版から二つの採用を競合 | 一方だけ`ADOPTED`、他方は`CONFLICT` | 未実行：版付き一括採用とDB競合 |
| A07 | `A07-readback-old-source.json` | 正式採用前に元CSVを読戻す | 作業成果物との不一致を正式採用せず、旧版へ自動復帰しない | 未実行：正式版参照と読戻し照合 |
| A08 | `A08-partial-apply.json` | 全割当の一部だけ保存・適用される | `PARTIAL`を成功にせず、個別勤務を正式採用しない | 未実行：一括保存transactionと結果照合 |
| A14 | `A14-readonly-export.json` | 読取専用接続から出力する | `EXPORTED_ONLY`を勤務確定と表示しない | 未実行：read-only adapterと画面境界 |
| A15 | `A15-endpoint-and-identity.json` | 宛先変更、接続別同一イベントID、他人の返信 | 宛先・接続範囲・本人同一性を混同しない | 未実行：模擬受信箱の永続化と認証済み回答者 |
| A18 | `A18-stop-and-limits.json` | 店長停止、回数・予算・期限到達 | 新規作用を止め、既確定事実を保持。`PREPARING`の結果不明は照合へ回す | 未実行：上限予約、停止排他、期限worker |

## 状態種別の扱い

- `UNKNOWN`：結果不明。再実行せず、照合可能なら照合する。照合不能でも、`PREPARING`中の
  停止では先に`RECONCILE_REQUIRED`へ保持し、未採用と断定して自動引き継ぎしない。
  `ATTENTION`／`HANDED_OFF`へ進む場合も採用事実を保持する。
- `PARTIAL`：一部作用の可能性を示す。全件成功にも全件未採用にも丸めず、個別の正式勤務を
  残さない。外部結果の照合が必要。
- `CONFLICT`：期待版や同じ操作IDの内容が一致しない。競合側を採用しない。
- `EXPORTED_ONLY`：出力成果物だけ。正式版参照、Schedule、採用済み勤務を変更しない。
- `PREPARED`：検査済み作業用成果物。正式採用ではない。

## 実行していない結合範囲

`origin/main`には、A側の案件状態機械、Commitment／SelectionResultの永続化、模擬受信箱の
受信イベント永続化、正式採用transaction、Gateway本体の結合実装がない。したがって、
この変更ではJSONと構造検証だけを実行する。各シナリオの`applicationAcceptance.reason`
と`requires`に、未実行理由と必要な結合条件を残している。

この共通契約の不足は[Q14](../../docs/OPEN-QUESTIONS.md)として未決のまま記録している。
fixtureの文字列参照をCommitment等の正式な業務契約と読み替えない。

fake Gatewayの結果を確認するテストを追加しても、application全体の受入合格へ昇格させない。
このworktreeは`origin/main`起点であり、別worktreeのfake Gateway実装は取り込まない。

## 結合時に確認するQuestion

- A04の勝者は操作IDの固定優先順位ではなく、同じ旧版への最初の成功したcompare-and-setで決める
  前提でよいか。fixtureは実行順を入れ替えても「採用1件・競合1件」を保つ期待にしている。
- A08の`internalFormalAdoptionCount`は内部transactionで正式採用として保存した件数を指し、
  `externalPartialMayHaveOccurred`は外部で一部作用した可能性を別に表す、という対応付けでよいか。
- A18の`PREPARING`中UNKNOWNは、ADR-022どおりまず`RECONCILE_REQUIRED`へ保持し、人が引き取るまで
  自動`HANDED_OFF`へ進めない前提でよいか。
