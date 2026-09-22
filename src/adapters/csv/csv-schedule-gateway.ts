/**
 * `ScheduleGateway` のCSV実装（RFC-010 §4・§6・§7、ADR-016、ADR-019、ADR-026）。担当B。
 *
 * 管理版ストア（`csv-store.ts`）の上に、契約の4操作を実装する。
 *
 *   - `loadSchedule`：正式版参照が指す管理版を読む。**版を照合してから**返す（D11／A01）
 *   - `applyUpdate`：期待版から次の版の作業用成果物を作り、`PREPARED` を返す。
 *     **正式採用ではない。** 正式版参照を切り替えるのはアプリケーション側の採用取引
 *   - `getUpdateResult`：操作記録を返す。無ければ「未実行」（下記）
 *   - `readBack`：成果物を読み戻す。参照から管理版IDだけを取り、パスを辿らない
 *
 * ## 能力の意味（正確に読むこと）
 *
 * `canConditionalUpdate: true` は「**期待版から派生した成果物しか作らない**」という意味。
 * 期待版がストアに無ければ `CONFLICT` を返し、別の版に更新を重ねない。ただし
 * 「期待版が今も正式版か」はここでは分からない——それを決めるのはDBの正式版参照で、
 * 採用取引の期待版付きCAS（`AuthoritativeScheduleRefRepository.swap`）が止める
 * （RFC-010 §5「直前のhash比較だけでは、その後に起きる変更を防げない」）。
 *
 * `supportsAtomicBatch: true` は、成果物が1つのディレクトリへ rename で現れるため、
 * 複数勤務の一部だけが書かれた成果物が正式な場所に存在しないことを指す。
 *
 * ## 「記録が無い」の意味
 *
 * `getUpdateResult` で操作記録が見つからないとき、`NOT_APPLIED` を返す。この adapter の
 * 外部作用は「管理版ストアへ成果物を書き、記録を残す」の一組で、記録は成果物の**後**に
 * 書く。記録が無ければ成果物は呼出し元へ報告されておらず、正式版参照がそれを指すことも
 * ない。つまり「反映していない」と言える。**接続そのものをストアが知らない場合は別**で、
 * 置き場所の設定違いかもしれないので `LOOKUP_UNAVAILABLE`（照会経路が無い）を返す。
 * 一般のSaaSでは「記録が無い＝未反映」とは言えないので、この判断をこの adapter の外へ
 * 持ち出さないこと。
 *
 * ## 出力のみモード（A14）
 *
 * `mode: "EXPORT_ONLY"` では成果物は作るが `EXPORTED_ONLY` を返す。アプリケーション側は
 * これを正式採用しない（`adopt-plan.ts`）。読取専用の接続から変更案を出す用途。
 */

import "server-only";
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
import type {
  ApplyUpdateCommand,
  AuthoritativeScheduleRef,
  LoadedAssignment,
  LoadedSchedule,
  ReadBackResult,
  ScheduleGateway,
  SourceCapabilities,
  UpdateResult,
} from "../../contracts/schedule-gateway";
import type { OperationId, RequestHash } from "../../contracts/operation";
import type { Clock } from "../../contracts/repository";
import {
  DEFAULT_CSV_STORE_ROOT,
  artifactRefOf,
  buildUpdatedInput,
  beginOperationRecord,
  completeOperationRecord,
  connectionKnown,
  isOperationInFlight,
  isRevisionId,
  readOperationRecord,
  readRevision,
  revisionOfArtifactRef,
  writeRevision,
} from "./csv-store";
import { parseMonthlyCsv, type CsvAssignment, type MonthlyCsv } from "./monthly-csv";

export const CSV_GATEWAY_CAPABILITIES: SourceCapabilities = {
  canReadRevision: true,
  canConditionalUpdate: true,
  supportsIdempotencyKey: true,
  supportsResultLookup: true,
  supportsAtomicBatch: true,
};

export type CsvGatewayMode = "ADOPT" | "EXPORT_ONLY";

export interface CsvScheduleGatewayOptions {
  /** 管理版ストアの置き場所。既定は `var/schedule`。テストは一時ディレクトリを渡す。 */
  readonly root?: string;
  /** `EXPORT_ONLY` は A14 の読取専用接続。成果物を作るが正式採用させない。 */
  readonly mode?: CsvGatewayMode;
  readonly clock?: Clock;
}

function nextMonth(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
}

/** 契約の形へ写す。CSV側の補助列（scheduleId・businessDate）は契約に無いので落とす。 */
function toLoaded(row: CsvAssignment): LoadedAssignment {
  return {
    shiftAssignmentId: row.shiftAssignmentId,
    staffId: row.staffId,
    roleCode: row.roleCode,
    startAt: row.startAt,
    endAt: row.endAt,
    status: row.status,
    ...(row.sourceCaseId ? { sourceCaseId: row.sourceCaseId } : {}),
  };
}

function refused(command: ApplyUpdateCommand, detail: string): UpdateResult {
  return {
    operation: { ...command.operation },
    kind: "NOT_APPLIED",
    revisionCheckEnforced: true,
    mappings: [],
    detail,
  };
}

export function createCsvScheduleGateway(options: CsvScheduleGatewayOptions = {}): ScheduleGateway {
  const root = options.root ?? DEFAULT_CSV_STORE_ROOT;
  const mode = options.mode ?? "ADOPT";
  const clock = options.clock ?? { now: () => new Date().toISOString() };

  /** 実行中マーカーを結果で置き換える。マーカーは `applyUpdate` の先頭で作っている。 */
  async function record(
    connectionId: string,
    operationId: OperationId,
    requestHash: RequestHash,
    startedAt: string,
    result: UpdateResult,
  ): Promise<UpdateResult> {
    await completeOperationRecord(root, {
      connectionId,
      operationId,
      requestHash,
      status: "DONE",
      startedAt,
      result,
      recordedAt: clock.now(),
    });
    return result;
  }

  function conflict(command: ApplyUpdateCommand, detail: string): UpdateResult {
    return {
      operation: { ...command.operation },
      kind: "CONFLICT",
      revisionCheckEnforced: true,
      mappings: [],
      detail,
    };
  }

  /** 同じ操作の別の呼出しが進行中。結果を待てないので成否不明として返す。 */
  function inFlight(command: ApplyUpdateCommand): UpdateResult {
    return {
      operation: { ...command.operation },
      kind: "UNKNOWN",
      revisionCheckEnforced: false,
      mappings: [],
      detail: "同じ操作の別の呼出しが進行中です。照会で確定してください。",
    };
  }

  return {
    capabilities: CSV_GATEWAY_CAPABILITIES,

    async loadSchedule(ref: {
      connectionId: string;
      scheduleId: string;
      authoritative?: AuthoritativeScheduleRef;
    }): Promise<LoadedSchedule> {
      if (!ref.authoritative) {
        // 取込みは scripts が行い、正式版参照はDBにできている前提。参照無しの読込みは
        // 「どの版を読むべきか決まっていない」ので、外部作用の前に断る。
        throw new TaskcalError(
          ERROR_CODES.NOT_CONFIGURED,
          "正式版参照が無いため、どの管理版を読むか決められません。勤務表を取り込んでください。",
        );
      }
      const revision = ref.authoritative.sourceRevision;
      // 成果物参照は管理版を指す形でなければならない。形が違う・版が違う参照は壊れている。
      const fromRef = revisionOfArtifactRef(ref.authoritative.artifactRef);
      if (fromRef !== revision) {
        throw new TaskcalError(
          ERROR_CODES.INVALID_INPUT,
          "正式版参照の版と成果物参照が一致しません。参照が壊れている可能性があります。",
        );
      }
      const parsed = await readRevision(root, ref.connectionId, revision);
      if (parsed === "NOT_FOUND") {
        // 参照はあるのに版が無い。ディスク障害等。旧版へ黙って戻らない（RFC-010 §4）。
        throw new TaskcalError(
          ERROR_CODES.INVALID_INPUT,
          "正式版参照が指す管理版がストアにありません。照合不能として停止します。",
        );
      }
      const days = parsed.manifest.days ?? [];
      if (!days.some((day) => day.scheduleId === ref.scheduleId.toLowerCase())) {
        throw new TaskcalError(
          ERROR_CODES.INVALID_INPUT,
          "指定された勤務表IDは、この管理版の対象月に含まれていません。",
        );
      }
      const month = parsed.manifest.month;
      return {
        scheduleId: ref.scheduleId,
        sourceRevision: parsed.sourceRevision,
        // 月次上限の検査は対象月の全日を要る（Q06／A09）。範囲は月全体。
        requestedRange: { fromDate: `${month}-01`, toDate: `${nextMonth(month)}-01` },
        completeness: parsed.completeness,
        missingDates: [...parsed.missingDates],
        assignments: parsed.assignments.map(toLoaded),
        // 範囲宣言のスタッフ集合。宣言外の相手を「勤務0件」と読ませない（Q06／A09）。
        declaredStaffIds: [...parsed.manifest.staffIds],
      };
    },

    async applyUpdate(command: ApplyUpdateCommand): Promise<UpdateResult> {
      const { connectionId } = command;
      const { operationId, requestHash } = command.operation;

      // ADR-006／D07：実行中マーカーを**排他的に**作る。作成に負けたら既存の記録と照合する。
      // 内容が違えば CONFLICT、同じで完了済みなら再生、同じで進行中なら成否不明。
      const startedAt = clock.now();
      let begun = await beginOperationRecord(root, {
        connectionId,
        operationId,
        requestHash,
        now: startedAt,
      });
      if (!begun.created) {
        const existing = begun.existing;
        if (existing.requestHash !== requestHash) {
          return conflict(command, "同じ操作IDで内容の異なる要求です。前回の結果を返せません。");
        }
        if (existing.status === "DONE" && existing.result) return existing.result;
        if (isOperationInFlight(existing, startedAt)) return inFlight(command);
        // 途中で落ちた前回の書込み。結果は返っていないので、やり直してよい（版は内容アドレス）。
        begun = await beginOperationRecord(root, {
          connectionId,
          operationId,
          requestHash,
          now: startedAt,
          takeOver: true,
        });
      }

      // 期待版から派生させる。期待版がストアに無ければ、別の版へ重ねずに CONFLICT。
      // 形が管理版IDでない値（旧seedの目印等）もストアには無いので同じ扱い。
      const base = isRevisionId(command.expectedSourceRevision)
        ? await readRevision(root, connectionId, command.expectedSourceRevision)
        : "NOT_FOUND";
      if (base === "NOT_FOUND") {
        return record(
          connectionId,
          operationId,
          requestHash,
          startedAt,
          conflict(command, "期待した版の管理版がストアにありません。"),
        );
      }
      const dayOfSchedule = (base.manifest.days ?? []).find(
        (day) => day.scheduleId === command.scheduleId.toLowerCase(),
      );
      if (!dayOfSchedule) {
        return record(
          connectionId,
          operationId,
          requestHash,
          startedAt,
          refused(command, "指定された勤務表IDは、この管理版の対象月に含まれていません。"),
        );
      }

      // 次の版の入力を作り、CSVの検査（形式・スタッフ・職種・15分刻み・最長時間・完全性）を通す。
      const built = buildUpdatedInput(base, command);
      if (!built.ok) {
        return record(
          connectionId,
          operationId,
          requestHash,
          startedAt,
          refused(command, built.detail),
        );
      }
      let next: MonthlyCsv;
      try {
        next = parseMonthlyCsv(built.csv, built.manifest);
      } catch (error) {
        if (error instanceof TaskcalError) {
          // 検査で弾いた。外部作用の前なので確定した「未反映」。
          return record(
            connectionId,
            operationId,
            requestHash,
            startedAt,
            refused(command, error.message),
          );
        }
        throw error;
      }

      // --- ここから外部作用。以後の例外は呼出し元が成否不明として扱う（RFC-010 §7）。 ---
      await writeRevision(root, connectionId, next);

      // 書込み完了した成果物を読み戻して、期待する版と件数を検査する（RFC-010 §4 手順4）。
      const back = await readRevision(root, connectionId, next.sourceRevision);
      if (back === "NOT_FOUND" || back.assignments.length !== next.assignments.length) {
        throw new TaskcalError(
          ERROR_CODES.RECONCILE_REQUIRED,
          "書き込んだ成果物を読み戻せません。成否不明として照合してください。",
        );
      }

      const result: UpdateResult = {
        operation: { ...command.operation },
        kind: mode === "EXPORT_ONLY" ? "EXPORTED_ONLY" : "PREPARED",
        artifactRef: artifactRefOf(next.sourceRevision),
        newSourceRevision: next.sourceRevision,
        revisionCheckEnforced: true,
        mappings: command.additions.map((addition) => ({
          commitmentId: addition.commitmentId,
          shiftAssignmentId: addition.shiftAssignmentId,
        })),
        detail:
          mode === "EXPORT_ONLY"
            ? "出力のみモード。元原本には反映していません。"
            : "検査済みの作業用CSVを作りました。正式採用はまだです。",
      };
      return record(connectionId, operationId, requestHash, startedAt, result);
    },

    async getUpdateResult(ref: {
      operationId: OperationId;
      connectionId: string;
      expectedRequestHash?: RequestHash;
    }): Promise<UpdateResult | "LOOKUP_UNAVAILABLE" | "CONFLICT"> {
      if (!(await connectionKnown(root, ref.connectionId))) {
        // 接続の置き場所が無い。設定違いかもしれないので「照会できない」で返す。
        return "LOOKUP_UNAVAILABLE";
      }
      const stored = await readOperationRecord(root, ref.connectionId, ref.operationId);
      if (stored === "NOT_FOUND") {
        // マーカーは成果物を書く**前**に排他的に作る。無ければこの操作は一度も始まっておらず、
        // 成果物も無い。「未実行の確認」（RFC-010 §7）が取れた状態。
        return {
          operation: {
            operationId: ref.operationId,
            // 記録が無いので内容ハッシュは分からない。契約上必須なので、照会側が渡した
            // 期待値か、明らかに実在しない値を入れる。照合には使わない。
            requestHash: ref.expectedRequestHash ?? "0".repeat(64),
          },
          kind: "NOT_APPLIED",
          revisionCheckEnforced: false,
          mappings: [],
          detail: "この操作の記録がありません。成果物は作られていません。",
        };
      }
      if (ref.expectedRequestHash && ref.expectedRequestHash !== stored.requestHash) {
        return "CONFLICT";
      }
      if (stored.status !== "DONE" || !stored.result) {
        const operation = { operationId: ref.operationId, requestHash: stored.requestHash };
        if (isOperationInFlight(stored, clock.now())) {
          // 書込み側がまだ生きている。未反映と断定せず、成否不明として待たせる。
          return {
            operation,
            kind: "UNKNOWN",
            revisionCheckEnforced: false,
            mappings: [],
            detail: "この操作はまだ実行中です。結果が確定するまで待ってください。",
          };
        }
        // 途中で落ちた書込み。結果は呼出し元へ返っておらず、正式版参照が指すこともない。
        return {
          operation,
          kind: "NOT_APPLIED",
          revisionCheckEnforced: false,
          mappings: [],
          detail: "この操作は結果を残さずに止まっています。成果物は報告されていません。",
        };
      }
      return stored.result;
    },

    async readBack(ref: { connectionId: string; artifactRef: string }): Promise<ReadBackResult> {
      const revision = revisionOfArtifactRef(ref.artifactRef);
      if (!revision) {
        throw new TaskcalError(ERROR_CODES.INVALID_INPUT, "成果物参照の形式が不正です。");
      }
      const parsed = await readRevision(root, ref.connectionId, revision);
      if (parsed === "NOT_FOUND") {
        throw new TaskcalError(ERROR_CODES.INVALID_INPUT, "成果物がストアにありません。");
      }
      return {
        artifactRef: ref.artifactRef,
        sourceRevision: parsed.sourceRevision,
        assignments: parsed.assignments.map(toLoaded),
      };
    },
  };
}
