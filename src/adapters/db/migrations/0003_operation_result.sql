-- 0003: 操作結果。担当A（Day 2）。
--
-- ADR-006 / RFC-009 D07：同じ操作IDで異なる内容は拒否し、同一内容は保存済み結果を返す。
-- 外部作用のある操作は接続範囲を持つ。宛先・接続を含めずにハッシュを作ると、
-- 別の接続への送信を同じ操作と誤認する（A15）。

create table operation_result (
  operation_id text primary key check (length(operation_id) between 1 and 128),
  -- char(64) にしない。空白詰めで requestHashSchema（^[0-9a-f]{64}$）と食い違う。
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  operation_kind text not null check (
    operation_kind in (
      'CREATE_CASE', 'START_OUTREACH', 'SEND_MESSAGE',
      'INTERPRET_REPLY', 'APPLY_UPDATE', 'ADOPT_PLAN'
    )
  ),
  connection_id text,
  case_id uuid,
  -- UNKNOWN は確定失敗ではない。照会して照合するまで再実行しない（RFC-010 §7）。
  status text not null check (status in ('IN_PROGRESS', 'SUCCEEDED', 'REFUSED', 'UNKNOWN')),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index operation_result_case on operation_result (case_id);

-- 保存済みの内容ハッシュを後から書き換えられないようにする。
-- 取得（insert ... on conflict ... where request_hash = excluded.request_hash）だけに
-- 頼ると、別経路の update が素通りする。
create function operation_result_hash_immutable () returns trigger language plpgsql as $$
begin
  if new.request_hash <> old.request_hash then
    raise exception '同じ operation_id で内容が異なります（ADR-006 / D07）'
      using errcode = '23514';
  end if;
  if new.operation_kind <> old.operation_kind then
    raise exception '同じ operation_id で操作種別が異なります（ADR-006 / D07）'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger operation_result_hash_immutable
before update on operation_result
for each row
execute function operation_result_hash_immutable ();
