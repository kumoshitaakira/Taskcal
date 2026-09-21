# tests

- `unit/` : 純粋な業務規則（B中心）
- `integration/` : 実DB・プロセス障害・競合（B中心、Aの結合部分を含む）
- `e2e/` : 主要画面・デモ初期化
- `unit/eval-fixtures.test.ts` : `fixtures/eval/`の構造・既存契約値・操作ハッシュの検証。
  application、DB、Gatewayを接続しないため、A02〜A18の受入合格を主張しない。

テスト名または追跡情報に受入ケースID（A01〜A18）を使う（AGENTS.md）。
決定的テストと、OrcaRouterを使う実モデル評価を分ける。実行していない受入ケースを
合格と記載しない。

`integration/` は起動中のPostgreSQLを必要とする（`docker compose up -d db`）。

## 受入ケースIDの付け方

実行していない受入ケースを合格と読ませない（AGENTS.md「品質と証拠」）。

| 書き方 | 意味 |
|---|---|
| `A15：…` | そのケースの入力と期待結果を、そのまま再現している |
| `A13の一部：…` | ケースの一部だけ。前提を fixture で作っている場合を含む |
| `A06の前提：…` | ケースが成り立つための下位の規則だけ。ケース自体は未実行 |

現在そのまま再現できているのは A11・A12・A15・A18の一部（予算・回数上限）に加え、
`integration/adopt-plan.test.ts` の A02・A03・A04・A05・A08 です。A07・A13 は一部のみ。

**`adopt-plan.test.ts` は選定そのものを検査していません。** `SelectionPlanner` と
`EligibilityChecker`（担当B）を `tests/fakes/` の台に差し替えており、Q02の被覆・重複や
月次上限の規則は動いていません。A16・A17 を合格と読まないでください。同じ理由で
`ScheduleGateway` も台です。CSVの往復（A01・A06・A14）は未実行のままです。

`tests/fakes/` は**テスト専用**です。`src/` へ入れないでください。合成の根
（`src/application/deps.ts`）には `NOT_IMPLEMENTED` を投げる実装だけを置きます。

受入fixtureだけを検査する場合は、リポジトリルートから次を実行する。

```bash
npx vitest run tests/unit/eval-fixtures.test.ts
```

このテストが成功しても、各fixtureの`applicationAcceptance.status`は`UNEXECUTED`のまま
である。実行していない結合ケースを合格と記録しない。
