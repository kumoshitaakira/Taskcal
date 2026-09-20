/**
 * 番号付きSQL migrationのrunner。担当A（ADR-003）。
 *
 * 保証：
 *   - ファイル名の番号順に、1ファイル1トランザクションで適用する。
 *   - 適用済みのファイルは内容hashを照合する。変更されていれば停止する。
 *     （適用済みmigrationの書き換えを黙って受け入れない。）
 *   - 同時実行を advisory lock で直列化する。
 *
 * 使い方: npm run migrate
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { config as loadDotenv } from "dotenv";
import { Pool } from "pg";

loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ path: ".env", quiet: true });

const MIGRATIONS_DIR = path.join(process.cwd(), "src", "adapters", "db", "migrations");
/** 同時に走ったmigrateを直列化するためのキー。 */
const ADVISORY_LOCK_KEY = 4_812_001;

type Migration = { readonly id: string; readonly filename: string; readonly sql: string };

async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((name) => name.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  const seenPrefixes = new Map<string, string>();

  for (const filename of files) {
    const id = filename.replace(/\.sql$/, "");
    const prefix = /^(\d{4})_/.exec(filename)?.[1];
    if (!prefix) {
      throw new Error(`migration名は4桁連番で始めてください: ${filename}`);
    }
    // 2人が並行に番号を振ると、同じ番号の別ファイルが両方適用され、
    // 適用順が辞書順に依存する。ここで止める。
    const duplicate = seenPrefixes.get(prefix);
    if (duplicate) {
      throw new Error(
        `migration番号が重複しています: ${duplicate} と ${filename}\n` +
          `どちらかに新しい番号を振り直してください。`,
      );
    }
    seenPrefixes.set(prefix, filename);

    migrations.push({
      id,
      filename,
      sql: await readFile(path.join(MIGRATIONS_DIR, filename), "utf8"),
    });
  }
  return migrations;
}

function hashOf(sql: string): string {
  // 改行コード差で別内容と判定しないよう正規化する。
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL が未設定です。.env.example を .env.local へ複製してください。");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      // 別のmigrateが固まったときに無言で永久待機しない。
      await client.query(`set lock_timeout = '30s'`);
      const locked = await client.query<{ acquired: boolean }>(
        `select pg_try_advisory_lock($1) as acquired`,
        [ADVISORY_LOCK_KEY],
      );
      if (!locked.rows[0]?.acquired) {
        throw new Error(
          "他のmigrateが実行中です。完了を待つか、停止しているプロセスが無いか確認してください。",
        );
      }
      await client.query(`
        create table if not exists schema_migrations (
          id text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);

      const migrations = await loadMigrations();
      const { rows } = await client.query<{ id: string; checksum: string }>(
        `select id, checksum from schema_migrations`,
      );
      const applied = new Map(rows.map((r) => [r.id, r.checksum]));

      // 適用済みのmigrationファイルが削除・改名されると、schema_migrations に行が
      // 残ったままファイルが無くなる。新しいDBではその変更が適用されず、既存DBには
      // 残るため、環境ごとにschemaが食い違う。checksum検査はファイルがある側しか
      // 見ないので、逆向きにも照合する。
      const knownIds = new Set(migrations.map((m) => m.id));
      const missing = [...applied.keys()].filter((id) => !knownIds.has(id)).sort();
      if (missing.length > 0) {
        throw new Error(
          `適用済みmigrationのファイルが見つかりません: ${missing.join(", ")}\n` +
            `削除・改名した場合は元に戻してください。取り消したい変更は、` +
            `新しい番号のmigrationで打ち消します。`,
        );
      }

      // 適用済みより小さい番号のmigrationが後から足されると、既存環境と新規環境で
      // 適用順が食い違い、schemaが環境ごとに変わる。
      const maxApplied = [...applied.keys()].sort().at(-1);
      if (maxApplied) {
        const outOfOrder = migrations.find((m) => !applied.has(m.id) && m.id < maxApplied);
        if (outOfOrder) {
          throw new Error(
            `適用順が逆転します: ${outOfOrder.filename} は適用済みの ${maxApplied} より前の番号です。\n` +
              `新しい番号へ振り直してください。`,
          );
        }
      }

      let appliedCount = 0;
      for (const migration of migrations) {
        const checksum = hashOf(migration.sql);
        const previous = applied.get(migration.id);
        if (previous !== undefined) {
          if (previous !== checksum) {
            throw new Error(
              `適用済みmigrationの内容が変更されています: ${migration.filename}\n` +
                `新しい番号のmigrationを追加してください。`,
            );
          }
          continue;
        }
        process.stdout.write(`applying ${migration.filename}\n`);
        try {
          await client.query("BEGIN");
          await client.query(migration.sql);
          await client.query(`insert into schema_migrations (id, checksum) values ($1, $2)`, [
            migration.id,
            checksum,
          ]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
        appliedCount += 1;
      }

      const latest = migrations.at(-1)?.id ?? "(none)";
      process.stdout.write(
        `migrate: applied=${appliedCount} total=${migrations.length} latest=${latest}\n`,
      );
    } finally {
      await client.query(`select pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]).catch(() => {});
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
