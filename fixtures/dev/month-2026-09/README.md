# 2026年9月の架空勤務表（開発用）

1店舗、職種`FLOOR`、架空スタッフ4人。実在する人・店舗のデータを含まない。
`manifest.json`は対象月の全30日について勤務IDを列挙し、勤務がない日も空配列で宣言する。
この宣言は開発者が管理するfixtureの前提であり、外部利用者の申告の正しさを保証しない。

| 日 | 架空スタッフ（UUID末尾） | 時間 | 状態 | 意図 |
| --- | --- | --- | --- | --- |
| 9/1 | 1 | 10〜18時 | COMPLETED | 完了済み8時間の通常勤務を保持 |
| 9/1 | 2 | 18〜22時 | COMPLETED | 完了済み勤務を0扱いしないための入力 |
| 9/10 | 3 | 18〜22時 | CANCELLED | 取消状態の往復 |
| 9/21 | 1 | 18〜22時 | SCHEDULED | 次段階の全時間欠勤シナリオの元勤務候補 |
| 9/21 | 2 | 12〜16時 | SCHEDULED | 同じ営業日の別勤務 |
| 9/22 | 3 | 18〜22時 | SCHEDULED | 対象日以外の勤務も月内入力に含む |
| 9/25 | 4 | 18〜20時 | SCHEDULED | 通常勤務。デモ欠勤対象に使用できる |

勤務IDはあらかじめ割り当てたUUID。CSVを並べ替えたり時刻を変更したりしても作り直さない。
行を追加・削除するfixture変更時は、その日の`assignmentIds`も更新する。
スタッフの表示名はCSVの列にも識別子にも含めない。

このfixtureは入力と往復検査のためのもの。承諾・正式採用・通知を実行した実績ではない。
在籍・可能時間・月次上限などの候補選定データと計算は次のステップで追加する。
欠勤の適用や欠勤区間の永続化も未実装。`CANCELLED`を欠勤の代用にしない。

リポジトリルートから`npx tsx scripts/check-csv.ts`で保存・読戻しを確認できる。
出力はgitignore対象の`var/csv-check/<sourceRevision>/schedule.csv`。
元CSVを上書きせず、正式版参照・業務DBも変更しない。

## 検証記録（2026-09-21）

- `npm run test:unit`：115件成功（うちCSVは24件）。A06の勤務ID往復とA09の入力完全性部分。
- `npm run typecheck`、`npm run lint`、`npm run check:docs`：成功。
- `npx tsx scripts/check-csv.ts`：初回保存と再実行の照合が成功。7勤務、`COMPLETE`、正式採用なし。
- 新規TypeScript・manifestの通常のPrettier検査は成功。
- 全体の`npm run format:check`は既存57ファイルの改行差（作業ツリーCRLF）で失敗。
  `npx prettier --check . --end-of-line auto`は成功。無関係なファイルは整形していない。

実行環境はWindows、Node.js 22.14.0。READMEのチーム想定20.19.5での再検証は未実施。
tsxはサンドボックス内のWindowsユーザー情報取得で失敗したため、CLIと文書検査は制限外で実行した。
画面、実DB、正式採用、案件参照、月次算式、実モデルはこの検証に含まない。
