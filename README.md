# Taskcal

Taskcalサービスのリポジトリ

飲食店の突発欠勤に対し、既存スタッフへの打診、返信の解釈、再調整、勤務条件の検査、シフト反映を進めるAIエージェントです。

ハッカソン向けの実装中です（Day 2、2026-09-22）。現時点で動くのは**欠勤の登録から、適格候補への同時打診、模擬受信箱への送信、返信の受信と永続化まで**です。返信の解釈はOrcaRouterが未設定のため実行できません。CSV取込・候補選定・正式採用は未実装です。

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
`parseMonthlyCsv`（正規化・安定ID・月内完全性）は入っていますが、アプリのDB・画面へは
まだ繋がっていません（`ScheduleGateway` 本体が未実装）。`authoritative_schedule_ref.source_revision`
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

`npm run test:integration` は専用の起動ゲートを通します。ローカルで`DATABASE_URL`が
未設定なら、従来どおり統合テストをskip可能とし、`[integration] SKIP`と
`[integration] RESULT: ...未実行`を標準エラーへ出します。`CI=true`または
`GITHUB_ACTIONS=true`の環境では、`DATABASE_URL`が未設定・空文字ならVitestを起動せず、
`[integration] ERROR`を出して失敗します。設定済みなら`[integration] RUN`を出して
PostgreSQL統合テストを実行します。これにより、CIの緑色が「成功」と「未実行」を隠しません。

### CI

`.github/workflows/ci.yml` がPRと `main` へのpushで走ります。**3つのジョブを並行**で
回します。ローカルで実行するコマンドと同じものを使います。

| ジョブ | 内容 | DB |
|---|---|---|
| 静的検査 | 環境ファイルの混入検査、`format:check`、`lint`、`typecheck`、`check:consistency`、`check:orca` | 不要 |
| ビルド | `build` | 不要 |
| テストとmigration | PostgreSQL serviceのhealthcheck完了後に`migrate`と再実行（`applied=0`）、`test:integration`（CIでは`DATABASE_URL`必須）、`test` | PostgreSQL 18 |

分割している理由は2つです。PostgreSQLの起動に17秒かかりますが、必要なのはテストだけで、
静的検査とビルドを待たせません。また直列だと、整形で落ちた時点でテストが走らず、修正して
push し直してから初めてテストの失敗に気付くことになります。並行なら全ての失敗が一度に出ます。

GitHub Actionsの`test`ジョブはPostgreSQL serviceのhealthcheckを定義しています。service
containerがhealthyになるまでjob stepは開始されないため、最初のmigration stepはDBの起動完了後に
実行されます。migrationは`src/adapters/db/migrations/`の承認済み番号付きSQLだけを通常runnerで
適用し、A承認前のdraftはCIへ持ち込みません。

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
src/domain/interval/      B  時間区間、重複、充足計算（README のみ。実装は未着手）
src/domain/selection/     B  候補評価、勤務計画の選定（同上）
src/adapters/csv/         B  固定CSV正規化・安定ID（Gateway本体は未実装）
fixtures/ tests/          B中心 デモデータ、単体・統合・受入試験
```

各層の規則はディレクトリのREADMEにあります。とくに
[`src/application/README.md`](src/application/README.md)（取引の中と外）と
[`src/app/README.md`](src/app/README.md)（Server Actionと冪等キー）を先に読んでください。

`src/contracts/` はA・Bの共同所有です。変更は、変更者でない側の確認を必須とします（ADR-021）。
Day 2で承諾（Commitment）・選定結果・打診の遷移・永続化の口を追加しました。Bの確認待ちです。
残る不足は [`src/contracts/README.md`](src/contracts/README.md) にあります。

### 現時点で動かないもの

デモや進捗報告で完成扱いにしないでください。

| 未達 | 理由 |
|---|---|
| CSVを読んで画面表示（A06のID往復はBのCLIと単体テストで確認済み） | 担当Bの `parseMonthlyCsv` は入ったが、`ScheduleGateway` 本体と画面・DBへの接続は未実装。画面が読む勤務表は `npm run seed:dev` が入れた架空データで、**CSVから往復したものではない** |
| 適格性の検査（可能時間・月次上限・勤務の重複） | 担当B。打診の候補は**名簿だけ**で選んでいる。正式採用の直前の再検査は `NOT_IMPLEMENTED` を投げる |
| 候補選定・勤務計画の決定（A16・A17） | 担当B |
| 返信解釈の実行、実推論1回のモデル・費用状態の保存 | OrcaRouterの接続情報と金額予算が未取得。**模擬結果は返しません** |
| 正式採用・CSV生成・読戻し・結果照合（A01〜A08、A14） | 次段階 |
| 送信結果が不明・配送に失敗した通知の復旧 | 未実装。`UNKNOWN` と `FAILED` の項目は**再送せず止まったまま**になる。同じ内容の再送は保存済み結果を返すだけなので、自動再送は空回りにしかならない。`getSendResult` での照合経路が要る |
| 期限の検知、案件の停止・再開、要対応からの復旧（A18の期限側） | Day 3 |
| worker の fence token | 通知待ちの lease はアイテム単位のみ |

そのまま再現できている受入ケースは **A11・A12・A15** と **A18の一部**（予算・回数上限）
だけです。A01・A03・A05・A06・A13 はテスト名に出てきますが、**前提または一部のみ**で、
前提を fixture で直接作っている場合があります（例：A13は「採用済み」をfixtureで作っており、
確定通知の失敗からの復旧は検証していません）。テスト名の付け方は
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

`src/adapters/orca/orca-client.ts` の要求・応答形式はOpenAI互換を仮定した下書きで、実接続で検証していません。

## Bの第1段階：CSV往復の確認

DB・OrcaRouter・画面を起動せず、リポジトリルートで実行できます。

```bash
npx tsx scripts/check-csv.ts
npx vitest run tests/unit/monthly-csv.test.ts
```

既存の単体テストも含める場合は`npm run test:unit`を使います。
変更確認には上記の`npm run format:check`、`npm run typecheck`、`npm run lint`も実行します。

[架空の月内fixture](fixtures/dev/month-2026-09/README.md)を読み、
`var/csv-check/<sourceRevision>/schedule.csv`へ正規化CSVを保存して読戻します。
同じ入力の再実行は既存出力と照合し、不一致なら上書きせず止まります。
元CSV・業務DB・正式版参照は変更しません。結果の`formallyAdopted: false`は、
勤務の正式採用をしていないことを示します。

ID付きの固定列CSVのみを対象とし、月内の入力完全性はJSON範囲宣言で検査します。
CSV形式は変更可能な実装上の仮定です。詳細は[RFC-010 §10](docs/rfc/RFC-010-csv-authority.md)を参照。
時間計算、月次上限、候補選定、欠勤適用、画面接続は次のステップです。

## 文書の扱い

現行方針・レビュー提案・未決事項を区別し、古いADRや提供資料は履歴として残します。過去資料内の「案05」「欠勤リカバリー」はTaskcalの旧呼称です。

サービス名と移管の記録は[ADR-020](docs/adr/ADR-020-taskcal-name.md)、価格・事業検証の仮説は[RFC-006](docs/rfc/RFC-006-business.md)を参照してください。

## AI開発環境

Codexを主系として、リポジトリ共通の指示を[`AGENTS.md`](AGENTS.md)に置いています。Claude Codeは[`CLAUDE.md`](CLAUDE.md)から同じ指示を読み込みます。実装・設計記録・レビューのスキルと、読み取り専用レビューエージェントの使い方は[AI開発ガイド](docs/AI-DEVELOPMENT.md)を参照してください。

`AGENTS.md`はこのリポジトリの指示の正本です。`next dev`が同ファイルへ独自の案内を追記しようとするため、`next.config.ts`で`agentRules: false`を設定して無効にしています。
