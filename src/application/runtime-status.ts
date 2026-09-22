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
    /**
     * schema検査を通った実呼出しの件数。
     *
     * **設定があることと、実際に通ったことを分ける。** 0件のまま「正常」と表示すると、
     * 一度も呼べていない接続を動作確認済みとして読ませる（AGENTS.md「品質と証拠」）。
     */
    readonly succeededCalls: number;
    /**
     * 結果不明で終わった呼出しの件数。0ではない費用が予約のまま残っている。
     * 失敗と断定しない（RFC-004 §7）。
     */
    readonly unknownCalls: number;
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

  const orcaConfigured = Boolean(
    orcaEnv?.ORCA_BASE_URL && orcaEnv?.ORCA_API_KEY && orcaEnv?.ORCA_MODEL,
  );
  // 実呼出しの実績を見る。設定の有無だけでは「動く」と言えない。
  const calls = database.status === "OK" ? await countModelCalls() : { succeeded: 0, unknown: 0 };
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
          : !orcaConfigured
            ? "UNCONFIGURED"
            : // 設定があるだけでは OK と言わない。schema検査を通った実呼出しが
              // 1件でもあって初めて、この接続で動いたと言える。
              calls.succeeded > 0
              ? "OK"
              : "CONFIGURED_UNVERIFIED",
      budgetConfigured,
      succeededCalls: calls.succeeded,
      unknownCalls: calls.unknown,
      ...(orcaInvalidKeys.length > 0 ? { invalidKeys: orcaInvalidKeys } : {}),
    },
    notImplemented: [
      "CSVとDB・画面の接続（ScheduleGateway本体）。parseMonthlyCsv はあるが繋がっておらず、画面の勤務表は npm run seed:dev の架空データ",
      "適格性の検査（可能時間・月次上限・勤務の重複）。打診の候補は名簿だけで選んでいる（担当B）",
      "候補選定・勤務計画の決定（担当B）",
      "返信解釈の品質評価（RFC-008の固定fixtureによる比較）。実呼出しは通っているが、精度は測っていない",
      "結果不明で終わったモデル呼出しの復旧。同じ受信は保存済みの結果不明を返し続ける（再送しないため）。人の対応が要る",
      "CSV生成・読戻し・結果照会（ScheduleGateway の実装）。正式採用の進行は実装済みだが、この口が NOT_IMPLEMENTED を投げるため成立しない（担当B）",
      "配送に失敗した通知の再送。UNKNOWN は getSendResult で照合するが、FAILED は止まったまま（attempt を含む操作IDが要る）",
      "停止の取消（案件の再開）。停止は取り消せない（D10）",
      "予算・回数上限に達した案件の停止。上限到達はモデル呼出しを断るだけで、案件は調整中のまま残る（A18の上限側）",
      "復旧しない要対応の案件を人が引き取る操作。自動では終端へ落とさない（ADR-022）",
      "採用済み勤務の取消・変更（D10：確定済みの取消は別の変更操作）",
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

/**
 * 実呼出しの実績を数える。
 *
 * **成功と結果不明を分けて数える。** 畳むと、課金の有無が分からない呼出しが
 * 成功として見える（RFC-004 §7）。
 */
async function countModelCalls(): Promise<{ succeeded: number; unknown: number }> {
  try {
    const { rows } = await getPool().query<{ succeeded: string; unknown: string }>(
      `select count(*) filter (where outcome = 'VALID')::text as succeeded,
              count(*) filter (where outcome = 'UNKNOWN')::text as unknown
         from model_call`,
    );
    return { succeeded: Number(rows[0]?.succeeded ?? 0), unknown: Number(rows[0]?.unknown ?? 0) };
  } catch {
    // 数えられないことを0と報告しない——と言いたいが、この値は表示専用で、
    // 呼出しの可否判定には使わない。読めなければ0件として控えめに出す。
    return { succeeded: 0, unknown: 0 };
  }
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
