import { describe, expect, it } from "vitest";
import { loadMigrationFiles } from "@/adapters/db/migration-files";

describe("migration files（静的検証）", () => {
  it("番号付きSQLを重複なく連番順に読み込む", async () => {
    const migrations = await loadMigrationFiles();
    const ids = migrations.map((migration) => migration.id);
    expect(ids[0]).toBe("0001_worker_runtime");
    expect(ids).toContain("0002_schedule_update");
    expect(ids).toContain("0003_outbound_operations");
    expect(new Set(migrations.map((migration) => migration.id)).size).toBe(migrations.length);
    expect(
      migrations.every((migration) => /^\d{4}_[a-z0-9_]+\.sql$/.test(migration.filename)),
    ).toBe(true);
  });

  it("SQL migrationへrunnerの取引制御を持ち込まない", async () => {
    const migrations = await loadMigrationFiles();
    for (const migration of migrations) {
      expect(migration.sql, migration.filename).not.toMatch(/\b(begin|commit)\b/i);
    }
  });

  it("未確定のCommitment等やworker lease/fenceのtableを作らない", async () => {
    const migrations = await loadMigrationFiles();
    for (const migration of migrations) {
      expect(migration.sql, migration.filename).not.toMatch(
        /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:commitment|selection_result|reply_interpretation|worker_lease)\b/i,
      );
      expect(migration.sql, migration.filename).not.toMatch(/\bfence_token\b/i);
    }
  });

  it("0002は操作の衝突、版、artifact、読戻し、採用事実を保持する", async () => {
    const migrations = await loadMigrationFiles();
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
    ]) {
      expect(scheduleUpdate?.sql).toContain(column);
    }
    expect(scheduleUpdate?.sql).toContain("RECONCILE_REQUIRED");
    expect(scheduleUpdate?.sql).toContain("UNKNOWN");
  });

  it("0003はprovider・connection・operationの範囲でoutbound操作を一意にする", async () => {
    const migrations = await loadMigrationFiles();
    const outbound = migrations.find((migration) => migration.id === "0003_outbound_operations");
    expect(outbound).toBeDefined();
    expect(outbound?.sql).toMatch(
      /unique\s*\(\s*provider\s*,\s*connection_id\s*,\s*operation_id\s*\)/i,
    );
    expect(outbound?.sql).toContain("request_hash");
    expect(outbound?.sql).toContain("UNKNOWN");
    expect(outbound?.sql).toContain("RECONCILE_REQUIRED");
  });
});
