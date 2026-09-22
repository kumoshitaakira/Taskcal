/**
 * migration下書きとrepository境界のPostgreSQL結合確認。
 *
 * DATABASE_URLが無い場合は、スキップを成功とは扱わず未実行としてstderrへ記録する。
 */

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeRequestHash } from "@/contracts/operation";
import { ERROR_CODES } from "@/contracts/errors";
import { loadDraftMigrationFiles, loadMigrationFiles } from "@/adapters/db/migration-files";
import {
  PgOutboundOperationRepository,
  PgScheduleUpdateRepository,
} from "@/adapters/db/repositories";

loadDotenv({ path: ".env.local", quiet: true });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write(
    "\n[integration] DATABASE_URL が未設定のため、repository統合テストは未実行です。\n" +
      "  実行するには: cp .env.example .env.local && docker compose up -d db\n\n",
  );
}

describe.skipIf(!connectionString)("PostgreSQL repository境界（DATABASE_URL 必須）", () => {
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 6 });
    schema = `taskcal_test_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    try {
      await client.query(`create schema "${schema}"`);
      await client.query(`set search_path to "${schema}"`);
      const files = [...(await loadMigrationFiles()), ...(await loadDraftMigrationFiles())];
      for (const file of files) await client.query(file.sql);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (!pool) return;
    const client = await pool.connect();
    try {
      await client.query("reset search_path");
      await client.query(`drop schema if exists "${schema}" cascade`);
    } finally {
      client.release();
    }
    await pool.end();
  });

  it("fresh DBへapproved migrationとdraft migrationを明示適用すると全表が作られる", async () => {
    const client = await connectInSchema(pool, schema);
    try {
      const { rows } = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = $1
            and table_name in ('worker_heartbeat', 'schedule_update', 'outbound_operation')
          order by table_name`,
        [schema],
      );
      expect(rows.map((row) => row.table_name)).toEqual([
        "outbound_operation",
        "schedule_update",
        "worker_heartbeat",
      ]);
    } finally {
      client.release();
    }
  });

  it("outboundの同一hashはREPLAY、異なるhashはOPERATION_CONFLICTになる", async () => {
    const repository = new PgOutboundOperationRepository();
    const operation = operationRef("outbound-replay");
    const input = {
      outboundOperationId: randomUUID(),
      provider: "fake-gateway",
      connectionId: "connection-a",
      operation,
      operationKind: "SCHEDULE_UPDATE",
    } as const;

    const first = await runTransaction(pool, schema, (tx) => repository.reserve(tx, input));
    expect(first.match).toBe("NEW");
    const replay = await runTransaction(pool, schema, (tx) =>
      repository.reserve(tx, { ...input, outboundOperationId: randomUUID() }),
    );
    expect(replay.match).toBe("REPLAY");

    await expect(
      runTransaction(pool, schema, (tx) =>
        repository.reserve(tx, {
          ...input,
          outboundOperationId: randomUUID(),
          operation: {
            operationId: operation.operationId,
            requestHash: computeRequestHash({ seed: "outbound-conflict" }),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.OPERATION_CONFLICT });
  });

  it("同時insertは一意制約で1行に収束し、後続は保存結果をREPLAYする", async () => {
    const repository = new PgOutboundOperationRepository();
    const operation = operationRef("outbound-concurrent");
    const input = {
      outboundOperationId: randomUUID(),
      provider: "fake-gateway",
      connectionId: "connection-concurrent",
      operation,
      operationKind: "SCHEDULE_UPDATE",
    } as const;
    const firstClient = await connectInSchema(pool, schema);
    const secondClient = await connectInSchema(pool, schema);
    try {
      await firstClient.query("begin");
      await secondClient.query("begin");
      const first = await repository.reserve(firstClient, input);
      const secondPromise = repository.reserve(secondClient, {
        ...input,
        outboundOperationId: randomUUID(),
      });
      await delay(25);
      await firstClient.query("commit");
      const second = await secondPromise;
      await secondClient.query("commit");
      expect(first.match).toBe("NEW");
      expect(second.match).toBe("REPLAY");
      const { rows } = await secondClient.query<{ count: string }>(
        `select count(*)::text as count from outbound_operation
          where provider = $1 and connection_id = $2 and operation_id = $3`,
        [input.provider, input.connectionId, input.operation.operationId],
      );
      expect(rows[0]?.count).toBe("1");
    } finally {
      await rollbackIfNeeded(firstClient);
      await rollbackIfNeeded(secondClient);
      firstClient.release();
      secondClient.release();
    }
  });

  it("IN_FLIGHTのcommit前に外部作用を開始できず、ロールバック後はNEWへ戻る", async () => {
    const repository = new PgOutboundOperationRepository();
    const operation = operationRef("outbound-commit-boundary");
    const base = {
      outboundOperationId: randomUUID(),
      provider: "fake-gateway",
      connectionId: "connection-commit-boundary",
      operation,
      operationKind: "SCHEDULE_UPDATE",
    } as const;
    await runTransaction(pool, schema, (tx) => repository.reserve(tx, base));

    await expect(
      runTransaction(pool, schema, async (tx) => {
        const started = await repository.beginExternalAttempt(tx, {
          provider: base.provider,
          connectionId: base.connectionId,
          operation,
        });
        expect(started.decision).toBe("START");
        throw new Error("simulate process termination before commit");
      }),
    ).rejects.toThrow("simulate process termination before commit");

    const afterRollback = await runTransaction(pool, schema, (tx) =>
      repository.findByOperation(tx, {
        provider: base.provider,
        connectionId: base.connectionId,
        operationId: operation.operationId,
      }),
    );
    expect(afterRollback?.state).toBe("NEW");

    const committed = await runTransaction(pool, schema, (tx) =>
      repository.beginExternalAttempt(tx, {
        provider: base.provider,
        connectionId: base.connectionId,
        operation,
      }),
    );
    expect(committed.decision).toBe("START");
    expect(committed.record.state).toBe("IN_FLIGHT");
  });

  it("再起動相当のIN_FLIGHT／UNKNOWNは再送せず照合し、同じ結果はREPLAYする", async () => {
    const repository = new PgOutboundOperationRepository();
    const operation = operationRef("outbound-restart");
    const base = {
      outboundOperationId: randomUUID(),
      provider: "fake-gateway",
      connectionId: "connection-restart",
      operation,
      operationKind: "SCHEDULE_UPDATE",
    } as const;
    await runTransaction(pool, schema, (tx) => repository.reserve(tx, base));

    const started = await runTransaction(pool, schema, (tx) =>
      repository.beginExternalAttempt(tx, {
        provider: base.provider,
        connectionId: base.connectionId,
        operation,
      }),
    );
    expect(started.decision).toBe("START");
    expect(started.record.state).toBe("IN_FLIGHT");

    const afterRestart = await runTransaction(pool, schema, (tx) =>
      repository.beginExternalAttempt(tx, {
        provider: base.provider,
        connectionId: base.connectionId,
        operation,
      }),
    );
    expect(afterRestart.decision).toBe("LOOKUP_REQUIRED");

    const unknown = await runTransaction(pool, schema, (tx) =>
      repository.recordResult(tx, {
        provider: base.provider,
        connectionId: base.connectionId,
        operation,
        state: "UNKNOWN",
        resultMetadata: { reason: "timeout" },
      }),
    );
    expect(unknown.match).toBe("APPLIED");
    const stillUnknown = await runTransaction(pool, schema, (tx) =>
      repository.beginExternalAttempt(tx, {
        provider: base.provider,
        connectionId: base.connectionId,
        operation,
      }),
    );
    expect(stillUnknown.decision).toBe("LOOKUP_REQUIRED");

    const replay = await runTransaction(pool, schema, (tx) =>
      repository.recordResult(tx, {
        provider: base.provider,
        connectionId: base.connectionId,
        operation,
        state: "UNKNOWN",
        resultMetadata: { reason: "timeout" },
      }),
    );
    expect(replay.match).toBe("REPLAY");

    const accepted = await runTransaction(pool, schema, (tx) =>
      repository.recordResult(tx, {
        provider: base.provider,
        connectionId: base.connectionId,
        operation,
        state: "ACCEPTED",
        providerOperationRef: "provider-operation-1",
      }),
    );
    expect(accepted.match).toBe("APPLIED");
    await expect(
      runTransaction(pool, schema, (tx) =>
        repository.recordResult(tx, {
          provider: base.provider,
          connectionId: base.connectionId,
          operation,
          state: "UNKNOWN",
          resultMetadata: { reason: "late-different-result" },
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECONCILE_REQUIRED });
  });

  it("ADOPTEDの証拠を要求し、採用後の後退を拒否する", async () => {
    const repository = new PgScheduleUpdateRepository();
    const operation = operationRef("schedule-adopted");
    const base = {
      scheduleUpdateId: randomUUID(),
      caseId: randomUUID(),
      scheduleId: randomUUID(),
      connectionId: "connection-schedule",
      operation,
      expectedSourceRevision: "r1",
    } as const;
    const started = await runTransaction(pool, schema, (tx) => repository.start(tx, base));
    expect(started.record.externalAttemptState).toBe("IN_FLIGHT");

    await expect(
      runTransaction(pool, schema, (tx) =>
        repository.recordOutcome(tx, {
          connectionId: base.connectionId,
          operation,
          state: "ADOPTED",
          revisionCheckEnforced: false,
          readBack: { status: "MATCHED" } as never,
          adoptionFact: "ADOPTED",
          resultMappings: [],
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });

    const prepared = await runTransaction(pool, schema, (tx) =>
      repository.recordOutcome(tx, {
        connectionId: base.connectionId,
        operation,
        state: "PREPARED",
        resultKind: "PREPARED",
        revisionCheckEnforced: true,
        readBack: { status: "MATCHED", sourceRevision: "r2", artifactRef: "artifact-1" },
        adoptionFact: "NOT_ADOPTED",
        resultMappings: [],
      }),
    );
    expect(prepared.match).toBe("APPLIED");

    const adoptedInput = {
      connectionId: base.connectionId,
      operation,
      state: "ADOPTED" as const,
      resultKind: "APPLIED" as const,
      sourceRevisionAfter: "r2",
      revisionCheckEnforced: true,
      artifactRef: "artifact-1",
      readBack: { status: "NOT_ATTEMPTED" as const },
      adoptionFact: "ADOPTED" as const,
      resultMappings: [],
    };
    await expect(
      runTransaction(pool, schema, (tx) =>
        repository.recordOutcome(tx, {
          ...adoptedInput,
          resultKind: "UNKNOWN",
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
    const adopted = await runTransaction(pool, schema, (tx) =>
      repository.recordOutcome(tx, adoptedInput),
    );
    expect(adopted.match).toBe("APPLIED");
    const replay = await runTransaction(pool, schema, (tx) =>
      repository.recordOutcome(tx, adoptedInput),
    );
    expect(replay.match).toBe("REPLAY");

    const readBackMismatchInput = {
      connectionId: base.connectionId,
      operation,
      readBack: { status: "MISMATCH" as const, detail: "正式版の読戻しが一致しない" },
    };
    const readBackMismatch = await runTransaction(pool, schema, (tx) =>
      repository.recordReadBack(tx, readBackMismatchInput),
    );
    expect(readBackMismatch.match).toBe("APPLIED");
    expect(readBackMismatch.record.state).toBe("ADOPTED");
    expect(readBackMismatch.record.adoptionFact).toBe("ADOPTED");
    expect(readBackMismatch.record.sourceRevisionAfter).toBe("r2");
    expect(readBackMismatch.record.artifactRef).toBe("artifact-1");

    const readBackReplay = await runTransaction(pool, schema, (tx) =>
      repository.recordReadBack(tx, readBackMismatchInput),
    );
    expect(readBackReplay.match).toBe("REPLAY");
    const adoptionReplayAfterReadBack = await runTransaction(pool, schema, (tx) =>
      repository.recordOutcome(tx, adoptedInput),
    );
    expect(adoptionReplayAfterReadBack.match).toBe("REPLAY");
    await expect(
      runTransaction(pool, schema, (tx) =>
        repository.recordReadBack(tx, {
          connectionId: base.connectionId,
          operation,
          readBack: {
            status: "MATCHED",
            sourceRevision: "wrong-revision",
            artifactRef: "wrong-artifact",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_INPUT });
    const afterRestart = await runTransaction(pool, schema, (tx) =>
      repository.findByOperation(tx, {
        connectionId: base.connectionId,
        operationId: operation.operationId,
      }),
    );
    expect(afterRestart).toMatchObject({
      state: "ADOPTED",
      adoptionFact: "ADOPTED",
      sourceRevisionAfter: "r2",
      artifactRef: "artifact-1",
      readBack: { status: "MISMATCH", detail: "正式版の読戻しが一致しない" },
    });

    await expect(
      runTransaction(pool, schema, (tx) =>
        repository.recordReadBack(tx, {
          connectionId: base.connectionId,
          operation,
          readBack: { status: "UNKNOWN", detail: "読戻しの結果不明" },
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECONCILE_REQUIRED });

    await expect(
      runTransaction(pool, schema, (tx) =>
        repository.recordOutcome(tx, {
          ...adoptedInput,
          state: "REJECTED",
          resultKind: "NOT_APPLIED",
          revisionCheckEnforced: false,
          readBack: { status: "NOT_ATTEMPTED" },
          adoptionFact: "NOT_ADOPTED",
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.RECONCILE_REQUIRED });
  });

  it("DBのCHECKと部分unique indexは禁止状態と二重採用を拒否する", async () => {
    const client = await connectInSchema(pool, schema);
    try {
      await expect(
        client.query(
          `insert into schedule_update
             (schedule_update_id, case_id, schedule_id, connection_id, operation_id,
              request_hash, expected_source_revision, state)
           values ($1, $2, $3, $4, $5, $6, $7, 'PREPARING')`,
          [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            "constraint",
            "invalid-hash",
            "not-a-hash",
            "r1",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        client.query(
          `insert into schedule_update
             (schedule_update_id, case_id, schedule_id, connection_id, operation_id,
              request_hash, expected_source_revision, source_revision_after,
              revision_check_enforced, artifact_ref, state, external_attempt_state,
              result_kind, adoption_fact)
           values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, 'ADOPTED',
              'RESULT_RECORDED', 'UNKNOWN', 'ADOPTED')`,
          [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            "constraint",
            "unknown-adopted",
            "d".repeat(64),
            "r1",
            "r2",
            "artifact-unknown",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        client.query(
          `insert into schedule_update
             (schedule_update_id, case_id, schedule_id, connection_id, operation_id,
              request_hash, expected_source_revision, source_revision_after,
              revision_check_enforced, artifact_ref, state, external_attempt_state,
              result_kind, read_back_status, read_back_source_revision,
              read_back_artifact_ref, adoption_fact)
           values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, 'ADOPTED',
              'RESULT_RECORDED', 'APPLIED', 'MATCHED', 'wrong-revision',
              'wrong-artifact', 'ADOPTED')`,
          [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            "constraint",
            "mismatched-adopted-read-back",
            "e".repeat(64),
            "r1",
            "r2",
            "artifact-2",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        client.query(
          `insert into schedule_update
             (schedule_update_id, case_id, schedule_id, connection_id, operation_id,
              request_hash, expected_source_revision, state, adoption_fact)
           values ($1, $2, $3, $4, $5, $6, $7, 'PREPARED', 'ADOPTED')`,
          [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            "constraint",
            "adopted-fact-on-prepared",
            "f".repeat(64),
            "r1",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        client.query(
          `insert into schedule_update
             (schedule_update_id, case_id, schedule_id, connection_id, operation_id,
              request_hash, expected_source_revision, state)
           values ($1, $2, $3, $4, $5, $6, $7, 'FORBIDDEN')`,
          [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            "constraint",
            "forbidden-state",
            "a".repeat(64),
            "r1",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        client.query(
          `insert into schedule_update
             (schedule_update_id, case_id, schedule_id, connection_id, operation_id,
              request_hash, expected_source_revision, state, read_back_status)
           values ($1, $2, $3, $4, $5, $6, $7, 'PREPARING', 'MATCHED')`,
          [
            randomUUID(),
            randomUUID(),
            randomUUID(),
            "constraint",
            "missing-read-back",
            "b".repeat(64),
            "r1",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        client.query(
          `insert into outbound_operation
             (outbound_operation_id, provider, connection_id, operation_id,
              request_hash, operation_kind, state)
           values ($1, $2, $3, $4, $5, $6, 'FORBIDDEN')`,
          [randomUUID(), "constraint", "constraint", "forbidden-outbound", "c".repeat(64), "TEST"],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const caseId = randomUUID();
      await insertAdoptedDirect(client, caseId, "direct-1");
      await expect(insertAdoptedDirect(client, caseId, "direct-2")).rejects.toMatchObject({
        code: "23505",
      });
    } finally {
      client.release();
    }
  });
});

async function connectInSchema(pool: Pool, schema: string): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query(`set search_path to "${schema}"`);
  return client;
}

async function runTransaction<T>(
  pool: Pool,
  schema: string,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await connectInSchema(pool, schema);
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await rollbackIfNeeded(client);
    throw error;
  } finally {
    client.release();
  }
}

function operationRef(seed: string) {
  return {
    operationId: `operation-${seed}`,
    requestHash: computeRequestHash({ seed }),
  } as const;
}

async function insertAdoptedDirect(client: PoolClient, caseId: string, operationId: string) {
  const sourceRevision = `source-${operationId}`;
  const artifactRef = `artifact-${operationId}`;
  return client.query(
    `insert into schedule_update
       (schedule_update_id, case_id, schedule_id, connection_id, operation_id, request_hash,
        expected_source_revision, source_revision_after, revision_check_enforced, artifact_ref,
        state, external_attempt_state, result_kind, read_back_status, read_back_source_revision,
        read_back_artifact_ref, adoption_fact, result_mappings)
     values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, 'ADOPTED', 'RESULT_RECORDED',
        'APPLIED', 'MATCHED', $8, $9, 'ADOPTED', '[]'::jsonb)`,
    [
      randomUUID(),
      caseId,
      randomUUID(),
      "direct",
      operationId,
      computeRequestHash({ operationId }),
      "expected",
      sourceRevision,
      artifactRef,
    ],
  );
}

async function rollbackIfNeeded(client: PoolClient): Promise<void> {
  await client.query("rollback").catch(() => undefined);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
