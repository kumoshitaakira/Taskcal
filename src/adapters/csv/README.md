# src/adapters/csv

**担当B** — CSV正規化、安定ID、管理版ストア、`ScheduleGateway`（RFC-012 §3.1、作業U02・U04）。
2026-09-22（Day 4）に本体が入り、合成の根（`src/application/deps.ts`）へ繋がった。

| ファイル | 内容 |
|---|---|
| `monthly-csv.ts` | 固定形式の月内CSVの取込み・正規化・出力（`parseMonthlyCsv`）。第1段階から |
| `csv-store.ts` | 管理版ストアの配置と読み書き、更新内容の組立て。`server-only` を付けず scripts と共有 |
| `csv-schedule-gateway.ts` | `ScheduleGateway` の実装（`loadSchedule` / `applyUpdate` / `getUpdateResult` / `readBack`） |

## 管理版ストア（ADR-026）

```text
var/schedule/<接続>/revisions/<sourceRevision>/schedule.csv   管理版CSV（不変・内容アドレス）
var/schedule/<接続>/revisions/<sourceRevision>/manifest.json  同じ版の範囲宣言
var/schedule/<接続>/operations/<操作>.json                    applyUpdate の操作記録
```

- 管理版は内容hash（`sourceRevision`）で置く。同じ内容は同じ場所、別の内容は別の場所。
  一度書いた版は書き換えない。書込みは一時ディレクトリへ完全に書いてから rename する。
- **ストアにあることと正式版であることは別。** 正式版はDBの `authoritative_schedule_ref`
  だけが決める。`applyUpdate` が作った版も、採用取引が参照を切り替えるまでは
  「未採用の成果物」として保持されるだけで、勤務照会には混ざらない（RFC-010 §4）。
- 成果物参照（`artifactRef`）は `revisions/<sourceRevision>`。`readBack` はここから管理版IDだけを
  取り、パスを辿らない（ADR-008）。
- 取込みは `npm run seed:dev` / `npm run reset:dev`（`scripts/lib/dev-seed.ts`）が固定fixtureを
  検査して置く。アップロード等の外部取込み経路は無い。

## Gateway の能力と限界

- `canConditionalUpdate: true` は「期待版から派生した成果物しか作らない」の意味。期待版が
  ストアに無ければ `CONFLICT`。**期待版が今も正式版か**を決めるのはDB側の期待版付きCAS
  （`swap`）で、adapter は知らない（RFC-010 §5）。
- 管理版は月単位、正式版参照は営業日単位。採用取引は対象日の `swap` の後、同月の他営業日を
  `advanceSiblings` で同じ版へ進める（ADR-026）。進めないと次の案件が旧版を読み、採用済みの
  代替勤務を月次上限に数えない（A01／A09）。
- `getUpdateResult` は、操作記録が無ければ `NOT_APPLIED`（記録は成果物の後に書くので、
  無ければ報告も採用もされていない）。接続自体をストアが知らなければ `LOOKUP_UNAVAILABLE`。
  この判断はローカルの管理版ストアに限る。SaaSへ持ち出さない。
- `mode: "EXPORT_ONLY"` は A14 の読取専用接続。成果物は作るが `EXPORTED_ONLY` を返し、
  アプリケーション側は正式採用しない。合成の根では `ADOPT` 固定。

守る規則（RFC-010）：

- CSVへ安定した勤務IDを含める。行番号・表示名・勤務内容のhashだけを勤務の恒久IDにしない（§3、A06）。
- 元ファイルを上書きしない。作業用の版を作り、書込み完了後に読み戻して検査する（§4 手順3-4）。
- `applyUpdate` が返す `PREPARED` は「検査済みの作業用CSVができた」であり、正式採用済みではない（§6）。
- 成否不明の項目を、空の成功結果として返さない（§6）。
- **欠勤を往復させる。** `PlannedAbsence` で欠勤にした勤務は、読み戻すと `ABSENT` として現れる。
  `CANCELLED` と混同しない。Q04により対象は全時間欠勤のみで、区間が元勤務と一致しなければ断る。

テスト：`tests/unit/monthly-csv.test.ts`（A06）、`tests/unit/csv-schedule-gateway.test.ts`
（A02・A06の前提・A07・A14、再生・内容不一致・期待版）、`tests/integration/csv-adoption.test.ts`
（A01・A02・A16を本番経路で）。CSV形式は[RFC-010 §10](../../../docs/rfc/RFC-010-csv-authority.md)。
