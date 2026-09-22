# fixtures/orca

**担当A** — OrcaRouterへの実接続を確かめるための入力。

`npm run check:orca:call` が読む。**1回だけ実呼出しする**ための最小の入力で、
架空のデータである（実在スタッフの返信ではない）。

## `fixtures/eval/` と混ぜない

| ディレクトリ | 何のためか |
|---|---|
| `fixtures/eval/` | 決定的な**受入fixture**（A02〜A18）。期待する終状態・採用事実・禁止する外部作用を固定する。`tests/unit/eval-fixtures.test.ts` が構造を検査する |
| `fixtures/orca/`（ここ） | **接続の疎通確認**の入力。受入ケースの期待値ではない |

`tests/unit/eval-fixtures.test.ts` は `fixtures/eval/` の**全JSON**を走査し、
`caseId` / `fixtureVersion` / `scenarios[]` / `applicationAcceptance` を要求する。
用途の違うJSONをそこへ置くと、受入fixtureの検証が落ちる。分けてあるのはそのため。

## 1回通ったことを評価と読まない

`check:orca:call` が成功しても、それは**接続と応答形式が通った**という意味しかない。
解釈の精度は測っていない。固定fixtureによる評価（RFC-008）は別に必要である。
