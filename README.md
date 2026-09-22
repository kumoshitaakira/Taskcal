# Taskcal

Taskcalサービスのリポジトリ

飲食店の突発欠勤に対し、既存スタッフへの打診、返信の解釈、再調整、勤務条件の検査、シフト反映を進めるAIエージェントです。

ハッカソン向けの実装中です（Day 2、2026-09-22）。現時点で動くのは**欠勤の登録から、適格候補への同時打診、模擬受信箱への送信、返信の受信、OrcaRouter経由の解釈、承諾の生成まで**です。正式採用の進行（選定の固定・作業用成果物の検査・一括採用・読戻し・通知）は実装しましたが、CSV取込と候補選定（担当B）が未実装のため、**本番経路では未実装として断ります**。

## まず読む文書

| 文書 | 内容 |
|---|---|
| [設計記録の索引](docs/README.md) | 現行仕様、ADR・RFC、新旧文書の適用範囲 |
| [現行ドメインモデル](docs/rfc/RFC-009-domain-v04.md) | 集約、承諾、勤務、時間、整合性 |
| [CSV原本と正式採用](docs/rfc/RFC-010-csv-authority.md) | 正式版参照、更新・照会、再起動・競合 |
| [同時対話と状態](docs/rfc/RFC-011-outreach-and-state.md) | 個別同時打診、自然文承諾、訂正・撤回 |
| [開発・受入計画](docs/rfc/RFC-012-delivery-and-acceptance.md) | 2人・4日の分担、仮見積り、確認ケース |
| [未決事項](docs/OPEN-QUESTIONS.md) | 実装前に選ぶ内容と推奨案 |
| [変更履歴](docs/CHANGELOG.md) | 方針の変更と過去資料の位置づけ |

## MVPの方針

- 架空の1店舗、同時1案件、必要勤務枠・職種は1つ。
- 適格なスタッフ全員への個別同時打診と、自然文返信に基づく調整。
- CSV勤務表、テスト用メッセージ環境、OrcaRouter経由の推論。
- 本人の条件を守り、成立しない場合は理由付きで店長へ引き継ぐ。

CSVの正式採用方式など、レビューによる提案と未決事項があります。名称の決定は、これら全てを採用済みに変更するものではありません。

## 開発環境

### 前提

| 項目 | 値 | 備考 |
|---|---|---|
| Node.js | 20.19.5（`.nvmrc`） | ADR-003の初期案は「Node 24系」。実機に入っていた20系をチーム共通版とする実装上の仮定 |
| npm | 11系 | `package-lock.json`を2人で共有する |
| Docker | Docker Desktop（起動していること） | PostgreSQL 18をComposeで動かす |

`nvm use` でNode版を合わせてください。

### 起動手順

```bash
cp .env.example .env.local     # 初回のみ。.env.local はコミットしない
npm install
docker compose up -d db        # PostgreSQL 18（ホスト側ポート 5433）
npm run migrate                # 番号付きSQL migration を適用
npm run seed:dev               # 架空の店舗・スタッフ・勤務表を入れる
npm run dev                    # http://localhost:3000
npm run worker                 # 別ターミナルで常駐worker（送信と解釈を回す）
```

画面：`/`（導線）、`/manager`（店長）、`/staff`（スタッフ役）、`/api/health`（起動状態のJSON）。

`npm run seed:dev` が入れるのは**架空データで、CSVの取込みではありません**。担当Bの
`parseMonthlyCsv`（正規化・安定ID・月内完全性）は入っています。`CsvScheduleGateway` は
作業用CSVの生成・操作結果照会・readBackまで実装済みですが、アプリのDB・画面や正式採用
applicationへはまだ繋がっていません。`authoritative_schedule_ref.source_revision`
にもCSVの内容hashではなくseedの目印が入ります。取込み済みと読まないでください。

初期状態へ戻す（データを消す）：

```bash
docker compose down -v && docker compose up -d db && npm run migrate && npm run seed:dev
```

### 通しで動かす

1. `/manager` で「欠勤する勤務」と回答期限を選び、**欠勤を登録する**。
2. 同じ画面で**打診を開始する**。欠勤者本人を除く同職種の全員へ個別に打診を積む。
   送信はworkerが取引の外で行う。
3. `/staff` に打診が届く。いずれかのスタッフ役から**返信する**。
4. `/manager` に「回答済み／受付済み／承諾なし／受信順 N（未処理）」が出る。

返信の解釈（承諾にするかどうか）はOrcaRouterが未設定のため動きません。画面と
`/api/health` の「未実装」にその旨を出します。

### 確認コマンド

コミット前に、変更に関係する以下を実行します。

```bash
npm run format:check   # prettier（docs/ は整形対象外）
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # vitest（unit + integration）
npm run build          # 本番ビルド
```

補助：

```bash
npm run format         # prettier --write
npm run seed:dev       # 架空データの投入（進行中の案件だけ片付けて入れ直す）
npm run check:consistency  # コードと文書、コード同士の食い違い（7項目。詳細はスクリプト冒頭）
npm run test:unit      # 単体のみ（DB不要）
npm run test:integration  # 統合のみ（起動中のDBが必要）
npm run check:orca     # OrcaRouterの設定点検（実呼出しはしない）
```

`npm test`がunit + integrationの正式なテスト入口です。ローカルで`DATABASE_URL`が未設定
なら、unitは実行し、integration本体はskipして`[integration] SKIP`と
`[integration] RESULT: ...未実行`を標準エラーへ出します。`CI=true`または
`GITHUB_ACTIONS=true`の環境では、`DATABASE_URL`が未設定・空文字ならVitestを起動せず、
`[integration] ERROR`を出して失敗します。設定済みなら`[integration] RUN`を出して
unit + PostgreSQL統合テストを一度だけ実行します。`npm run test:integration`は統合テストだけを
確認するfocused commandで、ローカル未設定時はVitest自体を起動せず未実行になります。

### CI

`.github/workflows/ci.yml` がPRと `main` へのpushで走ります。**3つのジョブを並行**で
回します。ローカルで実行するコマンドと同じものを使います。

| ジョブ | 内容 | DB |
|---|---|---|
| 静的検査 | 環境ファイルの混入検査、`format:check`、`lint`、`typecheck`、`check:consistency`、`check:orca` | 不要 |
| ビルド | `build` | 不要 |
| テストとmigration | PostgreSQL serviceのhealthcheck完了後に`migrate`と再実行（`applied=0`）、`npm test`（unit + integrationを1回） | PostgreSQL 18 |

分割している理由は2つです。PostgreSQLの起動に17秒かかりますが、必要なのはテストだけで、
静的検査とビルドを待たせません。また直列だと、整形で落ちた時点でテストが走らず、修正して
push し直してから初めてテストの失敗に気付くことになります。並行なら全ての失敗が一度に出ます。

GitHub Actionsの`test`ジョブはPostgreSQL serviceのhealthcheckを定義しています。service
containerがhealthyになるまでjob stepは開始されないため、最初のmigration stepはDBの起動完了後に
実行されます。`npm test`はmigration後に一度だけ実行されます。

MigrationのA承認は、A担当者がPull Request上のSQL差分を人手で確認することを意味します。
通常runnerは`src/adapters/db/migrations/`に置かれた全SQLを読むため、A承認前のdraftをこの
ディレクトリへ置かず、作業用の別worktree／別ディレクトリで管理します。CIのgreenや
`applied=0`は人手承認の証拠ではありません。承認済みとしてPRへ入ったSQLだけを通常runnerの
対象にします。今回の変更ではmigration SQLの内容を追加・確定していません。

CIはOrcaRouterのキーを持ちません。`check:orca` は設定の点検のみで、**実呼出しはしません**。
実モデル評価はCIの対象外で、手元で予算を設定して実行します（ADR-007）。

Codexによるレビューは、リポジトリに入れたGitHub Appが担当します。workflowでは動かして
いません。PRへ `@codex review` とコメントすると再実行できます。

### ディレクトリと担当

RFC-012 §3.1の所有範囲に対応します。所有は排他的な編集権ではなく、設計・完了・説明の責任です。

```text
src/app/                  A  店長画面・スタッフ画面・Server Action・Route Handler
src/application/          A  use case、状態遷移、取引境界
src/agent/                A  返信解釈の境界（README のみ。呼出しは application）
src/adapters/orca/        A  OrcaRouter、予算予約、使用量記録
src/adapters/db/          A  接続、transaction、migration runner、repository
src/adapters/db/migrations/ 番号帯で分ける（0002-0019=A、0020-=B。理由は同ディレクトリのREADME）
src/adapters/channel/     A  模擬メッセージ受信箱
src/worker/               A  常駐worker（送信・解釈）
src/contracts/            共同 API・イベント・モデル出力・永続化の契約
src/config/               A  環境変数の検査
src/domain/interval/      B  時間区間、重複、候補適格性、月次割当計算（U03実装済み）
src/domain/selection/     B  候補評価、勤務計画の選定（同上）
src/adapters/csv/         B  固定CSV正規化・安定ID・ScheduleGateway adapter
fixtures/ tests/          B中心 デモデータ、単体・統合・受入試験
```

各層の規則はディレクトリのREADMEにあります。とくに
[`src/application/README.md`](src/application/README.md)（取引の中と外）と
[`src/app/README.md`](src/app/README.md)（Server Actionと冪等キー）を先に読んでください。

`src/contracts/` はA・Bの共同所有です。変更は、変更者でない側の確認を必須とします（ADR-021）。
Day 2で承諾（Commitment）・選定結果・打診の遷移・永続化の口（選定結果・勤務表更新・
正式版参照・勤務の書込みを含む）を追加しました。Bの確認待ちです。
残る不足は [`src/contracts/README.md`](src/contracts/README.md) にあります。

### 現時点で動かないもの

デモや進捗報告で完成扱いにしないでください。

| 未達 | 理由 |
|---|---|
| CSVを読んで画面表示（A06のID往復はBのCLIと単体テストで確認済み） | `CsvScheduleGateway` の単体adapterは作業CSV・操作結果・readBackまで実装済みだが、画面・DBへ未接続。画面が読む勤務表は `npm run seed:dev` が入れた架空データで、**CSVから往復したものではない** |
| 本人の**可能時間**の検査 | 可能時間表がリポジトリに無い。承諾した区間をそのまま可能時間として渡しているため、可能時間の検査は**事実上恒真**（Q15）。月次上限・勤務の重複・在籍・職種は正式採用の直前に実際に検査している |
| 打診の宛先の適格性 | 候補は**名簿だけ**で選んでいる。検査が効くのは正式採用の直前だけで、打診の時点では効かない |
| 候補選定・勤務計画の決定（A16・A17） | 担当B |
| 返信解釈の**精度**（A16・A17の判定品質） | 実推論は通った（2026-09-22）が、RFC-008の固定fixtureによる評価はしていない。1回通ったことを精度の証拠にしない |
| 結果不明で終わったモデル呼出しの復旧 | 同じ受信は保存済みの結果不明を返し続ける（再送しないため）。人の対応が要る |
| 見積りの出力側の保守化 | 推論モデルでは `max_tokens` が効かず、**予約が実費を下回り得る**（`outputLimitExceeded` に記録）。無料モデルでは実害なしだが、有料へ切り替える前に決める必要がある |
| 正式採用・正式版参照の切替・application結果照合（A01〜A08、A14） | CSV adapterの作業成果物生成・readBack・操作照会は実装済み。正式採用とapplication/DBの結果照合は次段階 |
| 採用済み勤務の取消・変更 | D10により確定済みの取消は別の変更操作。未実装 |
| 配送に**失敗**した通知の再送 | `UNKNOWN` の照合は入った（`getSendResult` で照会し、送られたと確認できたときだけ進める）。`FAILED` は**止まったまま**で、`settle-reporting` が案件を要対応へ回す。同じ `operation_id` での再送は保存済みの失敗を返すだけなので、本当の再送には attempt を含む操作IDが要る |
| 停止の取消（案件の再開） | D10により確定済みの取消は別の変更操作。停止は取り消せない |
| 予算・回数上限に達した案件の停止（A18の上限側） | `STOP_CAUSE.LIMIT` に呼出し元がない。上限到達は**モデル呼出しを断るだけ**で、案件は調整中のまま残る。止めるには店長が手で停止する |
| 復旧しない案件の自動的な引き継ぎ | `ATTENTION` から `HANDED_OFF` へは**自動で落とさない**（ADR-022）。人が引き取る操作は未実装で、いまは `ATTENTION` のまま残る |
| worker の fence token | 通知待ちの lease はアイテム単位のみ。**採用の操作（`apply:*`）が進行中のまま落ちると、それが生きているのか死んでいるのかを区別できない。** 復旧は触らずに待つので、店長が画面から「停止の結果を確定させる」を押すまで案件が準備中のまま残る |
| 停止後に残る未配送の初回打診 | outbox に `PENDING` のまま残る（送らないだけで記録は消さない）。送信待ちの件数表示に混ざる |

受入ケースの状況は**3段に分かれます**。同じ「確認済み」で括らないでください。

| 段 | ケース | 意味 |
|---|---|---|
| 本番経路でそのまま再現 | A11・A12・A15、A18のうち店長停止・期限到達、A13のうち通知の照合 | 合成の根の実装で端から端まで通る |
| **担当Bの口を台（fake）に差し替えて手順だけ確認** | A02・A03・A05・A08、A04とA07とA13の一部、Q11・Q12・Q13の復旧経路 | 取引の切り方・再検査・照合・巻き戻しは確かめた。**選定規則とCSV往復は動いていない** |
| 未実行 | A01・A06・A14・A16・A17 | — |

台に差し替えているのは `SelectionPlanner`・`EligibilityChecker`・`ScheduleGateway`
（いずれも担当B）です。本番経路では正式採用の画面は必ず未実装通知で止まります。
A04は二重採用を止めるDB制約（部分一意索引・期待版付きCAS）だけを確かめており、
`adoptPlan` を2本走らせた競合は未実行です。テスト名の付け方は
[`tests/README.md`](tests/README.md) にあります。設計や fixture があることを合格と
読まないでください。

`0002` の勤務重複の排他制約は `btree_gist` を使います。拡張を作れない環境で制約を落とす場合は、
落とした事実をここへ必ず記録してください（黙って外さない）。

`/api/health` の `orcaRouter` は、接続設定があっても `CONFIGURED_UNVERIFIED`（設定あり・
未検証）までしか返しません。実接続を一度も確認していないため「正常」とは表示しません。

費用の上限は `case_spend_limit` / `run_spend_limit` / `case_call_limit` の3つで、金額は
**USDの整数micro単位**です（RFC-004 §7）。円換算は表示時のみ行います。`case_call_limit` の
既定は24（Q10の暫定値。検証前の上限候補であり、十分な回数だという保証ではありません）。
金額の上限値は単価判明後に設定します。

未決事項Q01〜Q13は2026-09-21に確定済みです（[未決事項](docs/OPEN-QUESTIONS.md)の
「確定した選択」）。Q10の金額上限だけは単価判明後に設定します。確定済みの条件を
実装時に決め直さないでください。

`src/adapters/orca/orca-client.ts` の要求・応答形式は2026-09-22に実接続で確認しました
（`npm run check:orca:call`）。`chat/completions` は通り、`modelReplyOutputSchema` を
通る出力が返りました。ただし **`response_format: json_schema` が効いたのか、プロンプト側の
schema指示で通ったのかは切り分けていません**（両方を送っているため）。

## Bの第1段階：CSV往復の確認

DB・OrcaRouter・画面を起動せず、リポジトリルートで実行できます。

```bash
npx tsx scripts/check-csv.ts
npx vitest run tests/unit/monthly-csv.test.ts
npx vitest run tests/unit/csv-schedule-gateway.test.ts
```

既存の単体テストも含める場合は`npm run test:unit`を使います。
変更確認には上記の`npm run format:check`、`npm run typecheck`、`npm run lint`も実行します。

受入fixtureの構造だけを確認する場合は次を実行します。application、DB、Gatewayを接続
しない決定的な検証であり、A02〜A18の受入合格を意味しません。

```bash
npx vitest run tests/unit/eval-fixtures.test.ts
```

[架空の月内fixture](fixtures/dev/month-2026-09/README.md)を読み、
`var/csv-check/<sourceRevision>/schedule.csv`へ正規化CSVを保存して読戻します。
同じ入力の再実行は既存出力と照合し、不一致なら上書きせず止まります。
元CSV・業務DB・正式版参照は変更しません。結果の`formallyAdopted: false`は、
勤務の正式採用をしていないことを示します。

ID付きの固定列CSVのみを対象とし、月内の入力完全性はJSON範囲宣言で検査します。
CSV形式は変更可能な実装上の仮定です。詳細は[RFC-010 §10](docs/rfc/RFC-010-csv-authority.md)を参照。
U03として時間計算、候補適格性、月次割当上限の決定的検査を追加済みです。承諾・候補選定、
欠勤適用、正式採用、画面接続は次の統合ステップです。

## 文書の扱い

現行方針・レビュー提案・未決事項を区別し、古いADRや提供資料は履歴として残します。過去資料内の「案05」「欠勤リカバリー」はTaskcalの旧呼称です。

サービス名と移管の記録は[ADR-020](docs/adr/ADR-020-taskcal-name.md)、価格・事業検証の仮説は[RFC-006](docs/rfc/RFC-006-business.md)を参照してください。

## AI開発環境

Codexを主系として、リポジトリ共通の指示を[`AGENTS.md`](AGENTS.md)に置いています。Claude Codeは[`CLAUDE.md`](CLAUDE.md)から同じ指示を読み込みます。実装・設計記録・レビューのスキルと、読み取り専用レビューエージェントの使い方は[AI開発ガイド](docs/AI-DEVELOPMENT.md)を参照してください。

`AGENTS.md`はこのリポジトリの指示の正本です。`next dev`が同ファイルへ独自の案内を追記しようとするため、`next.config.ts`で`agentRules: false`を設定して無効にしています。
