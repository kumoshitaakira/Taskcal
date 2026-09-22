# src/domain/selection

**担当B** — 候補評価と勤務計画の選定（RFC-012 §3.1、作業U03）。
2026-09-22（Day 4）に `index.ts`（`planExactlyOneCoverage`）が入り、`SelectionPlanner` として
合成の根から使われている。

守る規則（RFC-009 §6、D01〜D04）：

- 承諾時間を自動で短縮しない（ADR-005）。必要枠からはみ出す承諾は切り詰めずに**使わない**。
- 実行可能な計画だけを選定する。「有効な承諾すべての和集合で覆われる」ことと
  「同時に採用できる合法な勤務集合がある」ことは別。前者だけなら `OVERLAP`、和集合でも
  覆えなければ `NOT_COVERED` と理由を分ける。
- 選定できる承諾は最新の有効版だけ。確認中、期限切れ、撤回、未処理変更ありのものは
  呼出し元（`adopt-plan.ts`）が `isSelectableCommitment` で除いてから渡す（D04）。
  同じスタッフの承諾が複数来たら黙って片方を選ばず断る。
- 欠勤者本人を代替候補から除く（D01）。名簿の段階と適格性で除いている。
- 過去の辞退を候補順位の減点に使わない（ADR-008）。入力に含めない。
- 優先順位：勤務時間合計 → 人数 → 承諾が揃った順（受信順） → 安定ID順。

**Q02は2026-09-21に確定**：各区間ちょうど1人（`COVERAGE_MODE = "EXACTLY_ONE"`）。

重複する計画は採用しない。ただし**ある組合せが不成立でも案件全体を終了しない**。
`NOT_FEASIBLE` を受けた呼出し元は選定結果を残して調整中のまま据え置く（A16、A11）。
案件を引き継ぐ条件は別（候補枯渇・期限・上限）。

超過配置を禁止すると、完全充足計画の勤務時間合計は同率になるため、第1優先は実質的に
効かない。実際の順位は「人数 → 承諾が揃った順 → 安定ID順」になる（RFC-009 §6）。

Q06／A09：月内入力が `COMPLETE` でなければ計画を評価せず `INPUT_INCOMPLETE` を返す。
候補は最大 `MAX_STAFF`（8）で、部分集合の列挙（2^8）で足りる。超えたら範囲外として断る。

関連する受入ケース：A16、A11。テスト：`tests/unit/selection-planner.test.ts`、
`tests/integration/csv-adoption.test.ts`（本番経路でのA16・人数優先）。

## 担当Aが依存する口

`src/contracts/selection.ts`（契約は共同所有）。

- `SelectionPlanner.plan(input)`：純粋関数。`createSelectionPlanner()` が返す。
- `EligibilityChecker.listEligible` / `recheck`：適格性。規則は `src/domain/interval/`、
  写し替えは `src/application/outreach-eligibility.ts` と `eligibility-recheck.ts`。
  可能時間表が無いため、可能時間そのものは検査していない（Q15）。
