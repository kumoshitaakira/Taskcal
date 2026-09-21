# Taskcal

Taskcalサービスのリポジトリ

飲食店の突発欠勤に対し、既存スタッフへの打診、返信の解釈、再調整、勤務条件の検査、シフト反映を進めるAIエージェントです。

ハッカソン向けの実装を開始しました（2026-09-21、Day 1）。現時点で動くのは開発環境の起動（アプリ・DB・worker）と共通契約の下書きだけです。欠勤登録、打診、返信解釈、CSV取込、正式採用は未実装です。実接続・受入試験も未実施です。

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
npm run dev                    # http://localhost:3000
npm run worker                 # 別ターミナルで常駐worker
```

画面：`/`（導線）、`/manager`（店長）、`/staff`（スタッフ役）、`/api/health`（起動状態のJSON）。

初期状態へ戻す（データを消す）：

```bash
docker compose down -v && docker compose up -d db && npm run migrate
```

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
npm run check:docs     # 環境変数名・既定値とドキュメントの整合
npm run test:unit      # 単体のみ（DB不要）
npm run test:integration  # 統合のみ（起動中のDBが必要）
npm run check:orca     # OrcaRouterの設定点検（実呼出しはしない）
```

`DATABASE_URL` が未設定の場合、統合テストは実行されずskipされます。skipは合格では
ありません。skip時は理由が標準エラーへ出ます。

### CI

`.github/workflows/ci.yml` がPRと `main` へのpushで走ります。**3つのジョブを並行**で
回します。ローカルで実行するコマンドと同じものを使います。

| ジョブ | 内容 | DB |
|---|---|---|
| 静的検査 | 環境ファイルの混入検査、`format:check`、`lint`、`typecheck`、`check:docs`、`check:orca` | 不要 |
| ビルド | `build` | 不要 |
| テストとmigration | `migrate` と再実行（`applied=0`）、統合テストがskipされていないこと、`test` | PostgreSQL 18 |

分割している理由は2つです。PostgreSQLの起動に17秒かかりますが、必要なのはテストだけで、
静的検査とビルドを待たせません。また直列だと、整形で落ちた時点でテストが走らず、修正して
push し直してから初めてテストの失敗に気付くことになります。並行なら全ての失敗が一度に出ます。

CIはOrcaRouterのキーを持ちません。`check:orca` は設定の点検のみで、**実呼出しはしません**。
実モデル評価はCIの対象外で、手元で予算を設定して実行します（ADR-007）。

Codexによるレビューは、リポジトリに入れたGitHub Appが担当します。workflowでは動かして
いません。PRへ `@codex review` とコメントすると再実行できます。

## 文書の扱い

現行方針・レビュー提案・未決事項を区別し、古いADRや提供資料は履歴として残します。過去資料内の「案05」「欠勤リカバリー」はTaskcalの旧呼称です。

サービス名と移管の記録は[ADR-020](docs/adr/ADR-020-taskcal-name.md)、価格・事業検証の仮説は[RFC-006](docs/rfc/RFC-006-business.md)を参照してください。

## AI開発環境

Codexを主系として、リポジトリ共通の指示を[`AGENTS.md`](AGENTS.md)に置いています。Claude Codeは[`CLAUDE.md`](CLAUDE.md)から同じ指示を読み込みます。実装・設計記録・レビューのスキルと、読み取り専用レビューエージェントの使い方は[AI開発ガイド](docs/AI-DEVELOPMENT.md)を参照してください。

`AGENTS.md`はこのリポジトリの指示の正本です。`next dev`が同ファイルへ独自の案内を追記しようとするため、`next.config.ts`で`agentRules: false`を設定して無効にしています。
