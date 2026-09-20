# src/adapters/db/migrations

**担当B（作成）／A（承認）** — RFC-012 §3.1。

番号付きSQL migration。`0001_...sql` のように連番＋説明で命名する。

規則：

- 1ファイル = 1トランザクション。runner（`scripts/migrate.ts`）が `BEGIN`/`COMMIT` を
  付けるので、ファイル内に書かない。
- 適用済みのファイルは内容を変更しない。runnerが内容hashの変更を検出して停止する。
  変更したい場合は新しい番号のmigrationを追加する。
- 勤務ID・staffId・案件ID・操作ID・採用解釈・更新後CSV参照を欠落させない（RFC-009 §8）。
- 業務レコードはUUID、`created_at` を持つ。外部入力の店舗IDを信用せず、認証
  コンテキストから決めた値と照合する（ADR-008）。
- 同じ操作IDで異なる内容を拒否できる制約を置く（ADR-006 / RFC-009 D07）。

番号の割当：`0001_worker_runtime.sql` はworker基盤としてAが持つ。業務テーブルは
**0002以降**をBが使う。

`schema_migrations` テーブルはrunnerが自動で作る。ここに書かない。
