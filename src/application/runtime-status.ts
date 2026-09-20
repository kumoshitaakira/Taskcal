/**
 * 起動状態の点検。担当A。
 *
 * 目的は結合点の確認であり、業務機能ではない。
 * 未実装・未設定を「正常」と表示しないことを優先する（AGENTS.md「品質と証拠」）。
 */

import "server-only";
import { getPool } from "@/adapters/db/pool";
import {
  MIGRATION_SYNC,
  compareMigrations,
  loadMigrationFiles,
} from "@/adapters/db/migration-files";
import { serverEnvSchema } from "@/config/env-schema";

export type ComponentStatus =
  | "OK"
  /** 設定はあるが、実際に到達できるかを確認していない。「正常」と表示しない。 */
  | "CONFIGURED_UNVERIFIED"
  | "UNCONFIGURED"
  | "UNAVAILABLE"
  | "NOT_IMPLEMENTED";

export interface RuntimeStatus {
  readonly checkedAt: string;
  readonly database: {
    readonly status: ComponentStatus;
    readonly appliedMigrations: number;
    readonly latestMigration: string | null;
    /** 手元のmigrationファイルと適用履歴の照合結果。 */
    readonly migrationSync?: (typeof MIGRATION_SYNC)[keyof typeof MIGRATION_SYNC];
    readonly detail?: string;
  };
  readonly worker: {
    readonly status: ComponentStatus;
    readonly instanceId: string | null;
    readonly beatAt: string | null;
    readonly loopCount: number | null;
  };
  readonly orcaRouter: {
    readonly status: ComponentStatus;
    /** 金額上限（RFC-004 §7、Q10）が設定済みか。未設定なら有料呼出しを開始しない。 */
    readonly budgetConfigured: boolean;
    /** 設定値が契約に合わない場合。項目名だけを出し、値は出さない（ADR-008）。 */
    readonly invalidKeys?: readonly string[];
  };
  /** 実装していないものを一覧にする。デモで完成扱いにしないため。 */
  readonly notImplemented: readonly string[];
}

const WORKER_STALE_MS = 30_000;

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const checkedAt = new Date().toISOString();
  // 環境変数は項目ごとに見る。Orcaの設定が不正でも、DBの点検は独立して行う。
  const parsed = serverEnvSchema.safeParse(process.env);
  const env = parsed.success ? parsed.data : undefined;
  const invalidKeys = parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];

  const databaseConfigured =
    typeof process.env.DATABASE_URL === "string" &&
    process.env.DATABASE_URL.trim() !== "" &&
    !invalidKeys.includes("DATABASE_URL");

  const database = await checkDatabase(databaseConfigured);
  const worker = database.status === "OK" ? await checkWorker() : UNAVAILABLE_WORKER;

  const orcaInvalidKeys = invalidKeys.filter((k) => k.startsWith("ORCA_"));
  const orcaConfigured = Boolean(env?.ORCA_BASE_URL && env?.ORCA_API_KEY);
  const budgetConfigured = Boolean(
    env?.ORCA_CASE_SPEND_LIMIT_MICRO_USD !== undefined &&
    env?.ORCA_RUN_SPEND_LIMIT_MICRO_USD !== undefined &&
    env?.ORCA_ESTIMATED_MICRO_USD_PER_CALL !== undefined,
  );

  return {
    checkedAt,
    database,
    worker,
    orcaRouter: {
      // 設定値が不正なら、未設定とも正常とも言わない。
      status:
        orcaInvalidKeys.length > 0
          ? "UNAVAILABLE"
          : orcaConfigured
            ? // 実呼出しを一度も行っていないため、設定があっても OK とは言わない。
              "CONFIGURED_UNVERIFIED"
            : "UNCONFIGURED",
      budgetConfigured,
      ...(orcaInvalidKeys.length > 0 ? { invalidKeys: orcaInvalidKeys } : {}),
    },
    notImplemented: [
      "CSV取込・正規化・安定ID（担当B）",
      "時間区間・候補選定・月次上限（担当B）",
      "欠勤登録・同時打診・返信解釈（Day 2）",
      "正式採用・読戻し・結果照合（Day 2〜3）",
      "OrcaRouter実接続（接続情報と金額予算の確定後）",
    ],
  };
}

async function checkDatabase(configured: boolean): Promise<RuntimeStatus["database"]> {
  if (!configured) {
    // DATABASE_URL が無い、または不正。接続失敗ではなく未設定として区別する。
    return { status: "UNCONFIGURED", appliedMigrations: 0, latestMigration: null };
  }

  let applied: { id: string; checksum: string }[];
  try {
    const { rows } = await getPool().query<{ id: string; checksum: string }>(
      `select id, checksum from schema_migrations order by id`,
    );
    applied = rows;
  } catch (error) {
    if (error instanceof Error && /schema_migrations/.test(error.message)) {
      // 接続はできるがmigration未適用。「接続できない」と表示しない。
      return {
        status: "UNCONFIGURED",
        appliedMigrations: 0,
        latestMigration: null,
        migrationSync: MIGRATION_SYNC.PENDING,
        detail: "migration未適用（npm run migrate）",
      };
    }
    return {
      status: "UNAVAILABLE",
      appliedMigrations: 0,
      latestMigration: null,
      // 接続文字列や資格情報を出さない。
      detail: error instanceof Error ? error.name : "unknown error",
    };
  }

  // 追跡テーブルを引けたことをDB正常の証拠にしない。手元のファイルと両方向に
  // 照合する。最初のmigrationが失敗した場合も、未適用のまま起動した場合も検出する。
  let comparison;
  try {
    comparison = compareMigrations(await loadMigrationFiles(), applied);
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      appliedMigrations: applied.length,
      latestMigration: applied.at(-1)?.id ?? null,
      detail: error instanceof Error ? error.message : "migrationファイルを読めません",
    };
  }

  const base = {
    appliedMigrations: applied.length,
    latestMigration: applied.at(-1)?.id ?? null,
    migrationSync: comparison.sync,
  };

  if (comparison.sync === MIGRATION_SYNC.DIVERGED) {
    return {
      ...base,
      status: "UNAVAILABLE",
      detail: `適用履歴とファイルが一致しません: ${comparison.diverged.join(", ")}`,
    };
  }
  if (comparison.sync === MIGRATION_SYNC.PENDING) {
    return {
      ...base,
      status: "UNCONFIGURED",
      detail: `未適用のmigrationがあります（npm run migrate）: ${comparison.pending.join(", ")}`,
    };
  }
  return { ...base, status: "OK" };
}

const UNAVAILABLE_WORKER: RuntimeStatus["worker"] = {
  status: "UNAVAILABLE",
  instanceId: null,
  beatAt: null,
  loopCount: null,
};

async function checkWorker(): Promise<RuntimeStatus["worker"]> {
  try {
    const { rows } = await getPool().query<{
      instance_id: string;
      beat_at: Date;
      loop_count: string;
    }>(`select instance_id, beat_at, loop_count from worker_heartbeat where worker_name = $1`, [
      "main",
    ]);
    const row = rows[0];
    if (!row) return UNAVAILABLE_WORKER;
    const fresh = Date.now() - row.beat_at.getTime() < WORKER_STALE_MS;
    return {
      status: fresh ? "OK" : "UNAVAILABLE",
      instanceId: row.instance_id,
      beatAt: row.beat_at.toISOString(),
      loopCount: Number(row.loop_count),
    };
  } catch {
    return UNAVAILABLE_WORKER;
  }
}
