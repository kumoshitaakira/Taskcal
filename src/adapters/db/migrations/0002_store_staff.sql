-- 0002: 店舗・スタッフ・宛先・内部勤務表・正式版参照。担当A（Day 2）。
--
-- RFC-010 §2 の「Schedule（正式版から作った共通勤務表）」と「正式版参照」に対応する。
-- CSV原本の取込み・正規化は担当Bの `src/adapters/csv/` が行う（未実装）。このmigrationは
-- 取り込んだ結果を置く場所を作るだけで、CSVを読む経路を実装したことを意味しない。
--
-- 架空の1店舗・1職種・同時1案件（RFC-009 §2）。実在スタッフのデータは入れない。

create table store (
  store_id uuid primary key,
  name text not null,
  -- 表示と月境界はここに従う（RFC-009 §5）。
  timezone text not null,
  -- MVPは職種1種類（RFC-009 §2）。
  role_code text not null check (role_code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  created_at timestamptz not null default now()
);

create table staff (
  staff_id uuid primary key,
  store_id uuid not null references store (store_id),
  display_name text not null,
  role_code text not null check (role_code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  -- Q06：月次「割当」上限。実労働時間の上限判定ではない（勤怠実績を取得していない）。
  monthly_cap_minutes integer not null check (monthly_cap_minutes > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index staff_store on staff (store_id);

-- 連絡先。endpointKey が指す宛先を不変にし、変更時は版を上げる（RFC-011 §6）。
-- 途中の宛先変更で旧打診を別人へ送らないため、打診側は使用版を固定する。
create table contact_endpoint (
  provider text not null,
  connection_id text not null,
  endpoint_key text not null,
  staff_id uuid not null references staff (staff_id),
  endpoint_version integer not null default 1,
  -- 送信直前に検査する現在の連絡許可（RFC-011 §6）。版とは別の軸。
  contact_allowed boolean not null default true,
  -- 模擬受信箱の障害注入。**デモと受入試験のためのもので、本番の経路ではない。**
  mock_fault_mode text not null default 'NONE'
    check (mock_fault_mode in ('NONE', 'FAILED', 'UNKNOWN', 'LOOKUP_UNAVAILABLE')),
  created_at timestamptz not null default now(),
  primary key (provider, connection_id, endpoint_key)
);

create index contact_endpoint_staff on contact_endpoint (staff_id);

-- 1店舗・1営業日の勤務表（RFC-009 §3）。
create table schedule (
  schedule_id uuid primary key,
  store_id uuid not null references store (store_id),
  business_date date not null,
  constraint schedule_store_date unique (store_id, business_date)
);

-- 通常勤務と代替勤務を同じモデルで持つ（RFC-009 §3）。ScheduleUpdate から二重加算しない。
create table shift_assignment (
  shift_assignment_id uuid primary key,
  schedule_id uuid not null references schedule (schedule_id),
  store_id uuid not null references store (store_id),
  staff_id uuid not null references staff (staff_id),
  role_code text not null check (role_code ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- ABSENT（欠勤にした区間）と CANCELLED（勤務自体が無くなった）を混同しない。
  -- 月次上限は取消と欠勤区間の両方を除くため、区別が失われると集計が狂う（RFC-009 §5）。
  status text not null check (status in ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'ABSENT')),
  -- 代替勤務の由来。通常勤務は生成元を持たない（RFC-009 §4）。
  source_case_id uuid,
  -- D05：1つの承諾から作る勤務は1つ。外部キーは commitment を作る 0007 で足す。
  source_commitment_id uuid,
  created_at timestamptz not null default now(),
  constraint shift_assignment_range check (start_at < end_at)
);

create index shift_assignment_schedule on shift_assignment (schedule_id);
create index shift_assignment_staff on shift_assignment (staff_id, start_at);

-- D05 / A04：同じ承諾から二つの勤務を作らない。再試行で採番し直さない（RFC-010 §3）。
create unique index shift_assignment_one_per_commitment
  on shift_assignment (source_commitment_id)
  where source_commitment_id is not null;

-- ADR-006：同じスタッフの勤務が重なることをDB側でも拒否する。
-- btree_gist は PostgreSQL 13 以降 trusted だが、拡張を作れない環境では次の行が失敗する。
-- その場合はこの制約を落とし、コード側の重複検査だけに頼ることになるため、
-- 落とした事実を README の「現時点で動かないもの」へ必ず記録すること（黙って外さない）。
create extension if not exists btree_gist;

alter table shift_assignment
  add constraint shift_assignment_no_overlap
  exclude using gist (
    staff_id with =,
    tstzrange (start_at, end_at, '[)') with &&
  ) where (status in ('SCHEDULED', 'COMPLETED'));

-- 現在有効な管理版を指す小さなメタデータ（RFC-010 §2）。
-- D11：読込・再起動・次案件はすべてここから始める。古い入力パスを固定して使い続けない。
create table authoritative_schedule_ref (
  connection_id text not null,
  schedule_id uuid not null references schedule (schedule_id),
  -- 外部版・内容hash・不変な管理版IDのいずれか（RFC-010 §3）。
  source_revision text not null,
  artifact_ref text not null,
  adopted_at timestamptz not null,
  -- A04：期待版付きで切り替えるための版。同じ旧版からの二つの採用の一方だけを通す。
  version integer not null default 1,
  -- 正式採用を行った操作。0007 で外部キーを足す。
  adopted_by_schedule_update_id uuid,
  primary key (connection_id, schedule_id)
);
