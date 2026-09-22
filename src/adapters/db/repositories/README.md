# DB repository境界（下書き）

担当B作成、A確認待ち。`migrations/drafts/0002_schedule_update.sql` と
`migrations/drafts/0003_outbound_operations.sql` に対応する、DB adapter側の最小境界だけを置く。

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
- ScheduleUpdateの`start`は外部作用を呼ばず、`external_attempt_state=IN_FLIGHT`を保存する。
  `PREPARING`／`IN_FLIGHT`が残った再起動時は、ScheduleGatewayの結果照会を先に行い、
  このrepositoryから再送しない。outbound operationは`reserve`の後に、外部作用と同じ
  取引で`beginExternalAttempt`を呼ぶ。戻り値が`LOOKUP_REQUIRED`ならprovider照会が先である。
- 結果保存は行ロックと明示的な遷移検査を使う。同じ結果は`REPLAY`として保存済み行を返し、
  異なる結果、終端後の後退、古い結果は`RECONCILE_REQUIRED`として拒否する。UNKNOWNと
  RECONCILE_REQUIREDは成功・失敗へ自動変換しない。
- `ADOPTED`には`revision_check_enforced`、更新後`sourceRevision`、`artifactRef`、MATCHEDの
  読戻し証拠、`adoption_fact=ADOPTED`を要求する。正式採用直前の案件・勤務表・承諾などの
  再検査と一括保存はA側applicationの責務であり、この下書きが代替しない。

## 仮置き／A確認待ち

- `case_id`、`schedule_id`、`selection_result_ref` の外部キー対象と型の意味。
- `result_mappings` に含めるCommitment・SelectionResultの確定形。
- `outbound_operation.operation_kind` の語彙と、外部provider固有の結果metadata。
- worker lease/fence、Commitment、SelectionResult、永続化ReplyInterpretationのschema。
- ADOPTEDへ必要な正式版参照・案件版・最新承諾版・未処理返信・停止／期限／スタッフ条件・
  月次入力完全性の確定interface（A確認待ち）。
- `readBack`の外部provider別payload、`artifactRef`の寿命、`operation_kind`の確定語彙
  （A確認待ち）。

上記をこの下書きで確定しない。`src/contracts` は変更していない。

## テスト

`tests/unit/migration-files.test.ts` は承認済みmigrationと下書きの分離、SQL内の取引制御語、
禁止された最終schemaの作成、今回追加した制約と状態語彙を静的に検査する。
`tests/integration/db-repository.test.ts` はfresh schemaへ両方を明示適用し、PostgreSQLの
CHECK・部分unique index・repositoryの同時insert／再起動／単調遷移を検証する。
`DATABASE_URL`が無い場合はテストをスキップし、stderrへ未実行と記録する。未実行を合格とは扱わない。
