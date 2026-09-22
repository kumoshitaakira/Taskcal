-- 0003: 外部作用の冪等性・結果照合の記録下書き（B作成／A確認待ち）。
--
-- provider・connection_id・operation_idの範囲で一意にし、同じoperation_idへの
-- 異なるrequest_hashはrepository境界で拒否する。UNKNOWNとRECONCILE_REQUIREDを
-- 成功・確定失敗へ畳まず保存する。Message本文や秘密値はresult_metadataへ保存しない。

create table outbound_operation (
  outbound_operation_id uuid primary key,
  provider text not null,
  connection_id text not null,
  operation_id text not null,
  request_hash text not null,
  -- operation_kindの語彙はA・B共同確認待ち。未知のkindをmigrationで固定しない。
  operation_kind text not null,
  state text not null default 'NEW',
  provider_operation_ref text,
  artifact_ref text,
  result_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint outbound_operation_key
    unique (provider, connection_id, operation_id),
  constraint outbound_operation_id_length
    check (char_length(operation_id) between 1 and 128),
  constraint outbound_operation_request_hash_format
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint outbound_operation_state_values
    check (state in ('NEW', 'IN_FLIGHT', 'ACCEPTED', 'FAILED', 'UNKNOWN', 'RECONCILE_REQUIRED')),
  constraint outbound_operation_metadata_object
    check (result_metadata is null or jsonb_typeof(result_metadata) = 'object')
);

create index outbound_operation_lookup_idx
  on outbound_operation (provider, connection_id, operation_id);
