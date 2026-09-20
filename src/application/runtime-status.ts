/**
 * 起動状態の点検。担当A。
 *
 * 目的は結合点の確認であり、業務機能ではない。
 * 未実装・未設定を「正常」と表示しないことを優先する（AGENTS.md「品質と証拠」）。
 */

import "server-only";
import { getPool } from "@/adapters/db/pool";
import { getServerEnv } from "@/config/env";

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
  };
  /** 実装していないものを一覧にする。デモで完成扱いにしないため。 */
  readonly notImplemented: readonly string[];
}

const WORKER_STALE_MS = 30_000;

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const checkedAt = new Date().toISOString();
  const env = safeEnv();

  const database = await checkDatabase();
  const worker = database.status === "OK" ? await checkWorker() : UNAVAILABLE_WORKER;

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
      // 実呼出しを一度も行っていないため、設定があっても OK とは言わない。
      // 実接続の成否を確認する経路ができるまで CONFIGURED_UNVERIFIED のままにする。
      status: orcaConfigured ? "CONFIGURED_UNVERIFIED" : "UNCONFIGURED",
      budgetConfigured,
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

function safeEnv(): ReturnType<typeof getServerEnv> | null {
  try {
    return getServerEnv();
  } catch {
    return null;
  }
}

async function checkDatabase(): Promise<RuntimeStatus["database"]> {
  if (!safeEnv()) {
    // DATABASE_URL が無い。接続失敗ではなく未設定として区別する。
    return { status: "UNCONFIGURED", appliedMigrations: 0, latestMigration: null };
  }
  try {
    const { rows } = await getPool().query<{ count: string; latest: string | null }>(
      `select count(*)::text as count, max(id) as latest from schema_migrations`,
    );
    const row = rows[0];
    return {
      status: "OK",
      appliedMigrations: Number(row?.count ?? "0"),
      latestMigration: row?.latest ?? null,
    };
  } catch (error) {
    if (error instanceof Error && /schema_migrations/.test(error.message)) {
      // 接続はできるがmigration未適用。「接続できない」と表示しない。
      return {
        status: "UNCONFIGURED",
        appliedMigrations: 0,
        latestMigration: null,
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
