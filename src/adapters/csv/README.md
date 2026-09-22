# src/adapters/csv

**担当B** — CSV正規化、安定ID、読戻し（RFC-012 §3.1、作業U02・U04）。

`monthly-csv.ts`に固定形式の月内CSV取込・正規化・出力を実装済み。
`src/contracts/schedule-gateway.ts` の `ScheduleGateway` 本体（更新・操作照会・正式版接続）は次段階。

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

関連する受入ケース：A01、A02、A06、A07、A08、A14。
