# tests

- `unit/` : 純粋な業務規則（B中心）
- `integration/` : 実DB・プロセス障害・競合（B中心、Aの結合部分を含む）
- `e2e/` : 主要画面・デモ初期化

テスト名または追跡情報に受入ケースID（A01〜A18）を使う（AGENTS.md）。
決定的テストと、OrcaRouterを使う実モデル評価を分ける。実行していない受入ケースを
合格と記載しない。

`integration/` は起動中のPostgreSQLを必要とする（`docker compose up -d db`）。
