/**
 * migrationファイルの読み込みと照合。
 *
 * runner（`scripts/migrate.ts`）と起動状態の点検（`runtime-status.ts`）の両方が使う。
 * `server-only` を付けない（scriptsから使うため）。
 *
 * ファイルは実行時に `src/adapters/db/migrations/` から読む。開発・デモとも
 * リポジトリ直下から起動する前提（README の起動手順）。
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface MigrationFile {
  readonly id: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export function migrationsDir(): string {
  return path.join(process.cwd(), "src", "adapters", "db", "migrations");
}

export function draftMigrationsDir(): string {
  return path.join(migrationsDir(), "drafts");
}

/** 改行コード差で別内容と判定しないよう正規化する。 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * 番号順にmigrationを読む。番号の重複はここで停止する。
 * 2人が並行に番号を振ると、同じ番号の別ファイルが両方適用され、適用順が
 * 辞書順に依存するため。
 */
export async function loadMigrationFiles(): Promise<MigrationFile[]> {
  return loadMigrationFilesFrom(migrationsDir());
}

/** A確認前のmigration下書き。通常のrunnerからは読み込まない。 */
export async function loadDraftMigrationFiles(): Promise<MigrationFile[]> {
  return loadMigrationFilesFrom(draftMigrationsDir());
}

async function loadMigrationFilesFrom(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => name.endsWith(".sql")).sort();
  const migrations: MigrationFile[] = [];
  const seenPrefixes = new Map<string, string>();

  for (const filename of files) {
    const prefix = /^(\d{4})_/.exec(filename)?.[1];
    if (!prefix) {
      throw new Error(`migration名は4桁連番で始めてください: ${filename}`);
    }
    const duplicate = seenPrefixes.get(prefix);
    if (duplicate) {
      throw new Error(
        `migration番号が重複しています: ${duplicate} と ${filename}\n` +
          `どちらかに新しい番号を振り直してください。`,
      );
    }
    seenPrefixes.set(prefix, filename);

    const sql = await readFile(path.join(dir, filename), "utf8");
    migrations.push({
      id: filename.replace(/\.sql$/, ""),
      filename,
      sql,
      checksum: checksumOf(sql),
    });
  }
  return migrations;
}

/** 適用履歴と、手元のファイルの照合結果。 */
export const MIGRATION_SYNC = {
  /** 全て適用済みで内容も一致。 */
  UP_TO_DATE: "UP_TO_DATE",
  /** 未適用のmigrationがある。 */
  PENDING: "PENDING",
  /** 適用済みの内容が変わった、または適用済みファイルが消えた。 */
  DIVERGED: "DIVERGED",
} as const;

export type MigrationSync = (typeof MIGRATION_SYNC)[keyof typeof MIGRATION_SYNC];

export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
}

export interface MigrationSyncResult {
  readonly sync: MigrationSync;
  readonly pending: readonly string[];
  readonly diverged: readonly string[];
}

/**
 * 適用履歴と手元のファイルを両方向に照合する。
 *
 * 追跡テーブルがあることをDB正常の証拠にしない。最初のmigrationが失敗した場合も、
 * 新しいmigrationを未適用のまま起動した場合も、ここで検出する。
 */
export function compareMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationSyncResult {
  const appliedById = new Map(applied.map((a) => [a.id, a.checksum]));
  const knownIds = new Set(files.map((f) => f.id));

  const pending: string[] = [];
  const diverged: string[] = [];

  for (const file of files) {
    const appliedChecksum = appliedById.get(file.id);
    if (appliedChecksum === undefined) {
      pending.push(file.id);
    } else if (appliedChecksum !== file.checksum) {
      diverged.push(file.id);
    }
  }
  // 適用済みなのにファイルが無い（削除・改名）。
  for (const a of applied) {
    if (!knownIds.has(a.id)) diverged.push(a.id);
  }

  const sync =
    diverged.length > 0
      ? MIGRATION_SYNC.DIVERGED
      : pending.length > 0
        ? MIGRATION_SYNC.PENDING
        : MIGRATION_SYNC.UP_TO_DATE;

  return { sync, pending, diverged: diverged.sort() };
}
