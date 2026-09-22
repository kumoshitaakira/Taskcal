# src/adapters/csv

**担当B** — CSV正規化、安定ID、読戻し（RFC-012 §3.1、作業U02・U04）。

`monthly-csv.ts`に固定形式の月内CSV取込・正規化を、`schedule-gateway.ts`に
`ScheduleGateway`のCSV adapterを実装している。adapterは原CSVを読み取り専用で扱い、
`outputDir`以下へ作業用CSVとmanifest sidecarを保存する。

`unimplemented-schedule-gateway.ts` は**担当Aが暫定で置いたもの**。正式採用の進行
（`src/application/adopt-plan.ts`）は Gateway に対して書いてあるが、実装がまだ無い。
合成の根へ fake を入れると動いていないものが画面で動いて見えるため、模擬結果を返さず
`NOT_IMPLEMENTED` を投げる実装を置いている。**Bの `ScheduleGateway` が入ったら
`deps.ts` から外し、このファイルごと削除すること**（`runtime-status` の
`notImplemented` からも該当行を落とす）。

`parseMonthlyCsv(csv, manifest)`は通常・代替勤務を共通の`LoadedAssignment`に営業日と
勤務表IDを添えた形で返す。`normalizedCsv`を保存・再読込でき、入力順によらない
`sourceRevision`と入力完全性を返す。ID欠落時は拒否し、自動採番しない。

CSV列、範囲宣言、正規化、拒否条件は[RFC-010 §10](../../../docs/rfc/RFC-010-csv-authority.md)を参照。
固定形式は変更可能な実装上の仮定であり、共同のGateway契約は変更していない。
完全性は信頼するfixtureの宣言との一致を指し、外部原本の完全性や勤務条件の合法性を保証しない。

守る規則（RFC-010）：

- CSVへ安定した勤務IDを含める。IDが無い入力を受けるなら、初回にID付きの
  正規化版を作り、以後は同じIDを往復させる（§3）。
- 行番号・表示名・勤務内容のhashだけを勤務の恒久IDにしない。並べ替え・改名・
  時間変更と、別勤務の作成を区別する（A06）。
- 元ファイルを上書きしない。作業用CSVを作り、書込み完了後に**読み戻して**
  期待する勤務ID・担当者・役割・区間・件数を検査する（§4 手順3-4）。
- `applyUpdate` が返す `PREPARED` は「検査済みの作業用CSVができた」であり、
  正式採用済みではない。`ADOPTED` の判定はアプリケーションサービス側（§6）。
- 作業用領域と、公開される正式版参照を分ける。保存前のファイルを正式版として
  配布しない（§4）。作業用出力は `var/` 以下（gitignore済み）。
- 成否不明の項目を、空の成功結果として返さない（§6）。
- **欠勤を往復させる。** 書込み側の `PlannedAbsence` で欠勤にした勤務は、読み戻すと
  `LoadedAssignment.status === "ABSENT"` として現れること。`CANCELLED`（勤務自体が
  無くなった）と混同しない。月次上限は取消と欠勤区間の両方を除くため、再読込で
  区別が失われると集計が狂う（RFC-009 §5、A09）。Q04により対象は全時間欠勤のみ。

## ScheduleGateway adapter

`CsvScheduleGateway`へ参照用の`CsvScheduleSource`、作業成果物の`CsvArtifactStore`、
操作結果の`CsvOperationStore`を注入できる。`outputDir`だけを渡した場合は、既定で
`artifacts/`へ成果物、`operations/`へ接続ID＋operationId単位のJSON結果を保存する。
この2つは別のportであり、CSV成果物を操作結果のJSONへ埋め込まない。

`applyUpdate`は期待版の条件付き検査、固定済み追加・欠勤のCSV生成、書込み後のreadBackを
行い、成功時は`PREPARED`を返す。`PREPARED`は正式採用ではなく、正式版参照の切替と
案件状態の更新はapplication layerの責務である。原CSVは上書きしない。

既定のcapabilityは、版検査・操作結果照会・operationId冪等・一括CSV生成を全て保証する。
`canConditionalUpdate`がfalseの場合は`revisionCheckEnforced: false`、結果照会不能は
`LOOKUP_UNAVAILABLE`、複数勤務の一括保証不能は`NOT_APPLIED`として返す。版・完全性・
readBackを確認できない場合は`UNKNOWN`または`RECONCILE_REQUIRED`相当として保持し、
未適用や確定失敗へ丸めない。

### 起動例

```ts
const gateway = new CsvScheduleGateway({
  source: new FileCsvScheduleSource("fixtures/dev/month-2026-09/schedule.csv", "fixtures/dev/month-2026-09/manifest.json"),
  outputDir: "var/csv-gateway",
});
```

ファイルportはMVPのローカル成果物向けであり、DBの正式採用repositoryや正式版参照の
切替を代替しない。外部形式・成果物・操作照会の境界を保ったまま、application layerから
別の永続portへ差し替えられる。

関連する受入ケース：A01、A02、A06、A07、A08、A14。
