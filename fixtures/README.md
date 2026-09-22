# fixtures

**担当B** — デモ・評価用の架空データ（作業U02、U10）。

- `dev/` : 開発用。
- `eval/` : 決定的な受入fixture。A02、A03、A04、A07、A08、A14、A15、A18を固定し、
  最終評価の途中で変更しない（RFC-004）。形式と未実行の結合範囲は
  [`eval/README.md`](eval/README.md)を参照。

`dev/month-2026-09/`に固定CSVと全30日の範囲宣言を用意した。
詳細は[fixtureの説明](dev/month-2026-09/README.md)を参照。実モデル評価データではない。

規則：

- 実在スタッフのデータを置かない（AGENTS.md）。
- 月次を検査するなら、対象月の全入力または「他日は空」であることが分かる
  完全なfixtureにする。欠けた日を0と推定しない（RFC-009 §5、A09）。
- 決定的な事故試験のfixtureと、実モデル評価のfixtureを分ける。
- `eval/`の構造検証テストはfixtureの整合性だけを確認する。fake Gatewayやfixture検証の
  成功をapplication全体の受入合格とは扱わない。
- 返信のfixtureは例文だけにしない。**元打診・既存の承諾・確定前か確定後か・期待結果**を
  セットにする（Q09、`ReplyFixtureInput`）。同じ文面でも、確定前なら再計画、確定後なら
  人への引き継ぎになる。
- 範囲（最大8人・15分単位・最長4時間）は `src/config/mvp-policy.ts` に定数がある。
