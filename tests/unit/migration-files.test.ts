import { describe, expect, it } from "vitest";
import { loadDraftMigrationFiles, loadMigrationFiles } from "@/adapters/db/migration-files";

async function allMigrationFiles() {
  return [...(await loadMigrationFiles()), ...(await loadDraftMigrationFiles())];
}

describe("migration files（静的検証）", () => {
  it("番号付きSQLを重複なく連番順に読み込む", async () => {
    const migrations = await loadMigrationFiles();
    const ids = migrations.map((migration) => migration.id);
    expect(ids).toContain("0001_worker_runtime");
    expect(ids).not.toContain("0002_schedule_update");
    expect(ids).not.toContain("0003_outbound_operations");
    expect(new Set(migrations.map((migration) => migration.id)).size).toBe(migrations.length);
    expect(
      migrations.every((migration) => /^\d{4}_[a-z0-9_]+\.sql$/.test(migration.filename)),
    ).toBe(true);
  });

  it("SQL migrationへrunnerの取引制御を持ち込まない", async () => {
    const migrations = await allMigrationFiles();
    for (const migration of migrations) {
      expect(migration.sql, migration.filename).not.toMatch(/\b(begin|commit)\b/i);
    }
  });

  it("未確定のCommitment等やworker lease/fenceのtableを作らない", async () => {
    const migrations = await allMigrationFiles();
    for (const migration of migrations) {
      expect(migration.sql, migration.filename).not.toMatch(
        /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:commitment|selection_result|reply_interpretation|worker_lease)\b/i,
      );
      expect(migration.sql, migration.filename).not.toMatch(/\bfence_token\b/i);
    }
  });

  it("0002は操作の衝突、版、artifact、読戻し、採用事実を保持する", async () => {
    const migrations = await loadDraftMigrationFiles();
    const scheduleUpdate = migrations.find((migration) => migration.id === "0002_schedule_update");
    expect(scheduleUpdate).toBeDefined();
    expect(scheduleUpdate?.sql).toMatch(/unique\s*\(\s*connection_id\s*,\s*operation_id\s*\)/i);
    for (const column of [
      "request_hash",
      "expected_source_revision",
      "source_revision_after",
      "artifact_ref",
      "read_back_status",
      "read_back_source_revision",
      "read_back_artifact_ref",
      "adoption_fact",
      "revision_check_enforced",
      "external_attempt_state",
    ]) {
      expect(scheduleUpdate?.sql).toContain(column);
    }
    expect(scheduleUpdate?.sql).toContain("RECONCILE_REQUIRED");
    expect(scheduleUpdate?.sql).toContain("UNKNOWN");
    expect(scheduleUpdate?.sql).toMatch(/read_back_status\s*<>\s*'MATCHED'/i);
    expect(scheduleUpdate?.sql).toContain("schedule_update_adopted_evidence");
    expect(scheduleUpdate?.sql).toContain("schedule_update_adopted_read_back_match");
    expect(scheduleUpdate?.sql).toContain("schedule_update_adoption_fact_state");
    expect(scheduleUpdate?.sql).toMatch(/result_kind\s+in\s*\(\s*'PREPARED',\s*'APPLIED'/i);
  });

  it("0003はprovider・connection・operationの範囲でoutbound操作を一意にする", async () => {
    const migrations = await loadDraftMigrationFiles();
    const outbound = migrations.find((migration) => migration.id === "0003_outbound_operations");
    expect(outbound).toBeDefined();
    expect(outbound?.sql).toMatch(
      /unique\s*\(\s*provider\s*,\s*connection_id\s*,\s*operation_id\s*\)/i,
    );
    expect(outbound?.sql).toContain("request_hash");
    expect(outbound?.sql).toContain("UNKNOWN");
    expect(outbound?.sql).toContain("RECONCILE_REQUIRED");
  });

  it("通常runnerの適用対象とA確認待ち下書きを分離する", async () => {
    const approved = await loadMigrationFiles();
    const drafts = await loadDraftMigrationFiles();
    expect(approved.map((migration) => migration.id)).not.toContain("0002_schedule_update");
    expect(approved.map((migration) => migration.id)).not.toContain("0003_outbound_operations");
    expect(drafts.map((migration) => migration.id)).toEqual([
      "0002_schedule_update",
      "0003_outbound_operations",
    ]);
  });
});
