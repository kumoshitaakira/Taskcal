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
npm run test:unit      # 単体のみ（DB不要）
npm run test:integration  # 統合のみ（起動中のDBが必要）
npm run check:orca     # OrcaRouterの設定点検（実呼出しはしない）
```

`DATABASE_URL` が未設定の場合、統合テストは実行されずskipされます。skipは合格では
ありません。skip時は理由が標準エラーへ出ます。

### ディレクトリと担当

RFC-012 §3.1の所有範囲に対応します。所有は排他的な編集権ではなく、設計・完了・説明の責任です。

```text
src/app/                  A  店長画面・スタッフ画面・Route Handlers
src/application/          A  use case、状態遷移、正式採用の進行制御
src/agent/                A  返信解釈、action選択、費用記録
src/adapters/orca/        A  OrcaRouter、予算予約、使用量記録
src/adapters/db/          A  接続、transaction、migration runner
src/adapters/db/migrations/ B作成・A承認（0001はworker基盤でA、業務は0002以降）
src/adapters/channel/     A  模擬メッセージ受信箱
src/worker/               A  常駐worker
src/contracts/            共同 API・イベント・モデル出力のschema
src/config/               A  環境変数の検査
src/domain/interval/      B  時間区間、重複、充足計算（README のみ。実装は未着手）
src/domain/selection/     B  候補評価、勤務計画の選定（同上）
src/adapters/csv/         B  CSV正規化、安定ID、読戻し（同上）
fixtures/ tests/          B中心 デモデータ、単体・統合・受入試験
```

`src/contracts/` はDay 1に共同で固定します。以後の変更は、変更者でない側の確認を必須とします（ADR-021）。
現時点では**下書き**で、承諾（Commitment）・選定結果・永続化した解釈の型がまだありません。
不足の一覧は [`src/contracts/README.md`](src/contracts/README.md) にあります。

### 現時点で動かないもの

RFC-012 §4のDay 1共同ゲートのうち、以下は**未達**です。デモや進捗報告で完成扱いにしないでください。

- CSVを読んで画面表示、並べ替え後も同じ勤務IDを維持（担当BのU02が未着手）
- 実推論1回のモデル・費用状態の保存（OrcaRouterの接続情報と金額予算が未取得。Q10未決）

`/api/health` の `orcaRouter` は、接続設定があっても `CONFIGURED_UNVERIFIED`（設定あり・
未検証）までしか返しません。実接続を一度も確認していないため「正常」とは表示しません。

費用の上限は `case_spend_limit` / `run_spend_limit` / `case_call_limit` の3つで、金額は
**USDの整数micro単位**です（RFC-004 §7）。円換算は表示時のみ行います。上限値そのものは
Q10で未確定です。

RFC-012 §2 が求める Q01〜Q07・Q09 の確定会議は未実施です。担当BのU02・U03は
Q02〜Q06の確定に依存するため、Day 2に入る前に固定してください。

`src/adapters/orca/orca-client.ts` の要求・応答形式はOpenAI互換を仮定した下書きで、実接続で検証していません。

## 文書の扱い

現行方針・レビュー提案・未決事項を区別し、古いADRや提供資料は履歴として残します。過去資料内の「案05」「欠勤リカバリー」はTaskcalの旧呼称です。

サービス名と移管の記録は[ADR-020](docs/adr/ADR-020-taskcal-name.md)、価格・事業検証の仮説は[RFC-006](docs/rfc/RFC-006-business.md)を参照してください。

## AI開発環境

Codexを主系として、リポジトリ共通の指示を[`AGENTS.md`](AGENTS.md)に置いています。Claude Codeは[`CLAUDE.md`](CLAUDE.md)から同じ指示を読み込みます。実装・設計記録・レビューのスキルと、読み取り専用レビューエージェントの使い方は[AI開発ガイド](docs/AI-DEVELOPMENT.md)を参照してください。

`AGENTS.md`はこのリポジトリの指示の正本です。`next dev`が同ファイルへ独自の案内を追記しようとするため、`next.config.ts`で`agentRules: false`を設定して無効にしています。
