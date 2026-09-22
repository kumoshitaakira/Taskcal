# src/domain/interval

**担当B** — 時間区間、重複、充足計算（RFC-012 §3.1、作業U03）。

守る規則（RFC-009 §5）：

- `TimeRange` は半開区間 `[start, end)`、`start < end`。
- 表示と月境界は `Store.timezone` に従う。
- 可能時間から既存勤務を差し引いた結果は**区間集合になり得る**。
  独立した複数の可能時間窓そのものは、候補時間がいずれか1つへ完全に収まるなら許可する。
  1つの可能時間窓が既存勤務によって分断された場合は、分断を1区間へ戻さず
  `OUT_OF_SCOPE` で明示的に拒否する（`src/contracts/errors.ts`）。
- 取得できていない勤務を0とみなさない。月次を検査するなら、対象月の
  全入力または「他日は空」の完全なfixtureが必要（A09）。
- 月次上限は、完了済みも含む予定区間を数え、取消と欠勤区間を除く（Q06初期推奨）。
  勤務状態がcompletedになっただけで枠を復活させない。

**Q03〜Q06は2026-09-21に確定済み**（`src/config/mvp-policy.ts`）。

- Q03 分断された空き時間：範囲外。`OUT_OF_SCOPE`で拒否。一区間へ丸めない
- Q04 部分欠勤：範囲外。全時間欠勤のみ。**今回は追加しない**
- Q05 日跨ぎ：範囲外。明示的に拒否
- Q06 月次上限：完了済みを含む予定区間。月内入力の完全性が必須

いずれも「範囲外」は拒否であって、近い値への丸めではない。その候補を使えなくても、
他候補の調整は続ける。

関連する受入ケース：A09、A10、A17。

## 担当Aが依存する口

`EligibilityChecker`（`src/contracts/selection.ts`）の中で使われる。提示できる区間の計算、
既存勤務を差し引いた空き、Q03の分断判定、月次割当の集計がここに要る。

`src/application/roster-eligibility.ts` は名簿だけで候補を並べるため、**可能時間を見ていない**。
今回の`index.ts`は時間・勤務条件上の候補適格性を計算するが、既存use caseの打診・選定・
正式採用へはまだ接続していない。

## 実装済みの純粋計算

`index.ts` は共有の `Commitment`／`SelectionResult` 契約を変更せず、次を決定的に検査する。

`MonthlyScheduleSnapshot` は、applicationの
`createMonthlyScheduleSnapshot` がCSVの完全性と対象月全日の宣言を検証した後に生成する。
snapshotには正式採用前の版再検査用に`sourceRevision`を保持する。

- `validateTimeRange`、`overlapsTimeRange`、`containsTimeRange`：半開区間、JST、15分境界、日跨ぎ
- `deriveAvailableIntervals`：同一スタッフの予定・完了勤務を可能時間から差し引く
- `calculateMonthlyAssignedMinutes`／`calculateMonthlyCapacity`：完全な月内入力で、`COMPLETED`を含め、`CANCELLED`と`ABSENT`を除外
- `evaluateCandidateEligibility`：在籍、店舗、職種、欠勤者除外、重複、可能時間、月次上限

月次上限の不足・不完全な入力は0分へ推測せずエラーにする。分断空き、日跨ぎ、15分境界外、
最長4時間超は`OUT_OF_SCOPE`として返す。候補の選定計画、承諾版の最新性、永続化・正式採用は
`src/domain/selection/`とA側の共有契約・applicationへ接続するまで扱わない。
