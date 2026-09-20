-- 0001: workerの稼働状況。担当A（worker基盤）。
--
-- 業務データではない。B が作る業務テーブルは 0002 以降を使う。
-- 再起動しても状態を失わないこと、および /api/health で worker の生存を
-- 確認できることだけを目的とする。

create table worker_heartbeat (
  worker_name text primary key,
  -- 起動ごとに変わるID。再起動を区別する。
  instance_id text not null,
  started_at timestamptz not null,
  beat_at timestamptz not null,
  -- 起動からの処理ループ回数。ジョブ処理自体はまだ未実装。
  loop_count bigint not null default 0
);
