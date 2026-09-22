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
import { databaseUrlSchema, orcaEnvSchema } from "@/config/env-schema";

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
  // 環境変数は**対象ごとに別々のschemaで**解析する。全体schemaを一度だけ通すと、
  // 片方の不正がもう片方の判定を巻き込む。DBが不正でもOrcaの設定は正しく報告し、
  // その逆も同じにする。
  const databaseConfigured = databaseUrlSchema.safeParse(process.env.DATABASE_URL).success;

  const database = await checkDatabase(databaseConfigured);
  const worker = database.status === "OK" ? await checkWorker() : UNAVAILABLE_WORKER;

  const orcaParsed = orcaEnvSchema.safeParse(process.env);
  const orcaEnv = orcaParsed.success ? orcaParsed.data : undefined;
  const orcaInvalidKeys = orcaParsed.success
    ? []
    : [...new Set(orcaParsed.error.issues.map((i) => String(i.path[0])))];

  const orcaConfigured = Boolean(orcaEnv?.ORCA_BASE_URL && orcaEnv?.ORCA_API_KEY);
  const budgetConfigured = Boolean(
    orcaEnv?.ORCA_CASE_SPEND_LIMIT_MICRO_USD !== undefined &&
    orcaEnv?.ORCA_RUN_SPEND_LIMIT_MICRO_USD !== undefined &&
    orcaEnv?.ORCA_INPUT_MICRO_USD_PER_KTOK !== undefined &&
    orcaEnv?.ORCA_OUTPUT_MICRO_USD_PER_KTOK !== undefined,
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
      "CSVとDB・画面の接続（ScheduleGateway本体）。parseMonthlyCsv はあるが繋がっておらず、画面の勤務表は npm run seed:dev の架空データ",
      "適格性の検査（可能時間・月次上限・勤務の重複）。打診の候補は名簿だけで選んでいる（担当B）",
      "候補選定・勤務計画の決定（担当B）",
      "返信解釈（OrcaRouterの接続情報と金額予算が未取得のため実推論を行っていない）",
      "正式採用・CSV生成・読戻し・結果照合",
      "送信結果が不明・配送に失敗した通知の復旧。UNKNOWN と FAILED は再送せず止まったまま",
      "期限の検知、案件の停止・再開、要対応からの復旧",
      "worker の fence token（通知待ちの lease はアイテム単位のみ）",
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
    // 未適用の判定はSQLSTATE 42P01（undefined_table）に限る。
    // エラー文の表名で判定すると、SELECT権限が無い場合や追跡表が壊れている場合も
    // 「migrateを実行してください」と誤った復旧案を出す。migrateでは直らない。
    if (isUndefinedTable(error)) {
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
    // 原因はサーバー側のログにだけ残す。HTTPで返る値には、サーバー上の絶対パスを
    // 含み得るエラー文を出さない（ADR-008：不要な情報をUIへ出さない）。
    console.error("[runtime-status] migrationファイルを読めません", error);
    return {
      status: "UNAVAILABLE",
      appliedMigrations: applied.length,
      latestMigration: applied.at(-1)?.id ?? null,
      detail: "migrationファイルを読めません（番号の重複・欠落を確認してください）",
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

/** PostgreSQL の undefined_table。 */
function isUndefinedTable(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42P01"
  );
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
