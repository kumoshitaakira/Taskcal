# DB repository境界（下書き）

担当B作成、A確認待ち。`0002_schedule_update.sql` と
`0003_outbound_operations.sql` に対応する、DB adapter側の最小境界だけを置く。

## 境界

- repositoryは取引を開始・確定しない。呼出し側が `withTransaction` で同じ `Tx` を渡す。
  正式採用で必要な正式版参照、勤務表、案件の確定事実、更新結果、通知待ちを一つの取引へ
  揃える責務はA側のapplicationに残す。
- `operationId` の検索範囲は、ScheduleUpdateでは `connectionId + operationId`、
  outbound operationでは `provider + connectionId + operationId` とする。DBの一意制約で
  同時insertを止め、既存行の `requestHash` と比較して同内容を `REPLAY`、異内容を
  `OPERATION_CONFLICT` として返す。
- `ScheduleUpdate.state`、`UpdateResult.kind`、`readBack.status`、`adoptionFact` は
  別々に保存する。`adoptionFact` から案件状態を推定せず、`HANDED_OFF`、`ATTENTION`、
  `RECONCILE_REQUIRED` を未採用へ丸めない。
- `sourceRevision` は更新前の期待版と更新後の版を分け、`artifactRef` と読戻し結果を
  保持する。`UNKNOWN` または `RECONCILE_REQUIRED` の行を、照会なしで再実行しない。
- `result_mappings` と `result_metadata` は、未確定のCommitment／SelectionResult／返信の
  最終schemaを決めないための不透明な保存欄。原文、秘密値、内部推論を入れない。

## 仮置き／A確認待ち

- `case_id`、`schedule_id`、`selection_result_ref` の外部キー対象と型の意味。
- `result_mappings` に含めるCommitment・SelectionResultの確定形。
- `outbound_operation.operation_kind` の語彙と、外部provider固有の結果metadata。
- worker lease/fence、Commitment、SelectionResult、永続化ReplyInterpretationのschema。

上記をこの下書きで確定しない。`src/contracts` は変更していない。

## テスト

`tests/unit/migration-files.test.ts` は全migrationの番号、SQL内の取引制御語、禁止された
最終schemaの作成、今回追加した制約と状態語彙を静的に検査する。通常のrepository DB結合は
A側のapplication／PostgreSQL接続と共同確認するまで実行済みとは扱わない。
