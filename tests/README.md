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

**本番経路でそのまま再現**できているのは A11・A12・A15・A18（店長停止・期限到達・予算・
回数上限）と、A13 のうち**通知の照合**（`integration/recover.test.ts` の
`reconcileOutbox`）です。停止（`integration/stop-case.test.ts`）は台を使っていません。

`integration/adopt-plan.test.ts` の A02・A03・A05・A08（および A04・A07・A13 の一部）は、
**担当Bの口を `tests/fakes/` の台に差し替えて手順だけを確認**したものです。同じ「確認済み」
で括らないでください。`SelectionPlanner`・`EligibilityChecker`・`ScheduleGateway` が台なので、
Q02の被覆・重複、月次上限、CSVの往復は動いていません。A16・A17・A01・A06・A14 は未実行です。

A04 は二重採用を止めるDB制約（部分一意索引・期待版付きCAS）だけを確かめており、
`adoptPlan` を2本走らせた競合は未実行です。

`integration/recover.test.ts` の Q11・Q12・Q13（案件の復旧）は、`ScheduleGateway` を
台に差し替えています。照会と読戻しの**結果に対する分岐**は確かめましたが、CSVの実際の
往復は動いていません。`reconcileOutbox` の側は模擬受信箱（本番と同じ実装）を使っています。

`tests/fakes/` は**テスト専用**です。`src/` へ入れないでください。合成の根
（`src/application/deps.ts`）には `NOT_IMPLEMENTED` を投げる実装だけを置きます。

受入fixtureだけを検査する場合は、リポジトリルートから次を実行する。

```bash
npx vitest run tests/unit/eval-fixtures.test.ts
```

このテストが成功しても、各fixtureの`applicationAcceptance.status`は`UNEXECUTED`のまま
である。実行していない結合ケースを合格と記録しない。
