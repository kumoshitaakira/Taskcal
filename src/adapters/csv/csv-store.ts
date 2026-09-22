/**
 * CSV管理版ストア（RFC-010 §2〜§4、ADR-026）。担当B。
 *
 * `ScheduleGateway`（`csv-schedule-gateway.ts`）と開発用の取込み（`scripts/`）が共有する
 * ファイル配置・読み書き・更新内容の組立て。**`server-only` を付けない**——scripts からも
 * 同じ配置規則で書くため。Next の境界の印は Gateway 側に付ける。
 *
 * 配置（`root` は既定で `var/schedule`。gitignore 済み）：
 *
 * ```text
 * <root>/<connection>/revisions/<sourceRevision>/schedule.csv   管理版CSV（不変）
 * <root>/<connection>/revisions/<sourceRevision>/manifest.json  同じ版の範囲宣言
 * <root>/<connection>/operations/<operation>.json               applyUpdate の操作記録
 * ```
 *
 * - **管理版は内容アドレス。** `sourceRevision` は `parseMonthlyCsv` が内容と範囲宣言から
 *   計算する SHA-256 なので、同じ内容は同じ場所に落ち、別の内容は別の場所へ入る。
 *   一度書いた版は書き換えない。
 * - **ストアにあることと正式版であることは別。** どの版が正式かを決めるのはDBの正式版参照
 *   （`authoritative_schedule_ref`）だけ。作業用に作った版もここに入るが、正式版参照が
 *   指すまでは「未採用の成果物」として保持されるだけで、勤務照会には混ざらない
 *   （RFC-010 §4「5で失敗した成果物は未採用として保持・整理し、勤務照会に混ぜない」）。
 * - **書込みは一時ディレクトリへ完全に書いてから rename する。** 途中で落ちても
 *   半端な版が正式な場所に現れない。ファイルとDBを1取引にできるとは仮定しない。
 * - ディレクトリ名は接続IDと操作IDから**ファイルシステムに安全な形**へ写す
 *   （`mock:demo` や `apply:<uuid>` はコロンを含み、Windowsでは使えない）。衝突を避ける
 *   ため短いハッシュを添え、記録側の JSON に元のIDを保持して読むときに照合する。
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
import type {
  ApplyUpdateCommand,
  AssignmentStatus,
  UpdateResult,
} from "../../contracts/schedule-gateway";
import type { RequestHash } from "../../contracts/operation";
import { toJstFixedFormat } from "../../domain/interval";
import { CSV_COLUMNS, parseMonthlyCsv, type CsvManifest, type MonthlyCsv } from "./monthly-csv";

/** 既定の置き場所。リポジトリの `var/` は gitignore 済み（RFC-010 §4）。 */
export const DEFAULT_CSV_STORE_ROOT = "var/schedule";

const SCHEDULE_FILE = "schedule.csv";
const MANIFEST_FILE = "manifest.json";
const REVISION_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_REF_PATTERN = /^revisions\/([0-9a-f]{64})$/;

/**
 * IDをディレクトリ名に使える形へ写す。
 * 元の値は記録側（JSON）に保持し、読むときに照合する。写像だけで同一性を決めない。
 */
export function fsSafeSegment(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
  const readable = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
  return `${readable}-${digest}`;
}

export function connectionRoot(root: string, connectionId: string): string {
  return path.join(root, fsSafeSegment(connectionId));
}

/** 管理版IDの形か。旧seedの目印（`seed:2026-09:1`）等はストアに存在し得ない。 */
export function isRevisionId(value: string): boolean {
  return REVISION_PATTERN.test(value);
}

export function revisionDirectory(root: string, connectionId: string, revision: string): string {
  if (!isRevisionId(revision)) {
    throw new TaskcalError(ERROR_CODES.INVALID_INPUT, "管理版IDの形式が不正です。");
  }
  return path.join(connectionRoot(root, connectionId), "revisions", revision);
}

function operationFile(root: string, connectionId: string, operationId: string): string {
  return path.join(
    connectionRoot(root, connectionId),
    "operations",
    `${fsSafeSegment(operationId)}.json`,
  );
}

/** 管理版を指す成果物参照。接続の根からの相対パス。 */
export function artifactRefOf(revision: string): string {
  return `revisions/${revision}`;
}

/** 成果物参照から管理版IDを取り出す。形が合わなければ `undefined`（パスを辿らない）。 */
export function revisionOfArtifactRef(artifactRef: string): string | undefined {
  return ARTIFACT_REF_PATTERN.exec(artifactRef)?.[1];
}

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * 管理版を読む。**保存名と内容の版が一致しなければ通さない。**
 * 一致しない版は破損か改変で、黙って読むと検査した内容と違う勤務を確定させる。
 */
export async function readRevision(
  root: string,
  connectionId: string,
  revision: string,
): Promise<MonthlyCsv | "NOT_FOUND"> {
  const directory = revisionDirectory(root, connectionId, revision);
  const [csv, manifest] = await Promise.all([
    readTextIfExists(path.join(directory, SCHEDULE_FILE)),
    readTextIfExists(path.join(directory, MANIFEST_FILE)),
  ]);
  if (csv === undefined || manifest === undefined) return "NOT_FOUND";
  const parsed = parseMonthlyCsv(csv, JSON.parse(manifest));
  if (parsed.sourceRevision !== revision) {
    throw new TaskcalError(
      ERROR_CODES.REVISION_CONFLICT,
      "管理版の内容が保存名の版と一致しません。破損または改変の可能性があります。",
    );
  }
  return parsed;
}

/**
 * 管理版を書く。一時ディレクトリへ完全に書いてから rename する。
 * 既にあれば内容を照合するだけで書き換えない（内容アドレスなので一致するはず）。
 */
export async function writeRevision(
  root: string,
  connectionId: string,
  parsed: MonthlyCsv,
): Promise<"WRITTEN" | "EXISTS"> {
  const directory = revisionDirectory(root, connectionId, parsed.sourceRevision);
  const existing = await readRevision(root, connectionId, parsed.sourceRevision);
  if (existing !== "NOT_FOUND") {
    if (existing.normalizedCsv !== parsed.normalizedCsv) {
      throw new TaskcalError(
        ERROR_CODES.REVISION_CONFLICT,
        "同じ版IDで内容の異なる管理版があります。上書きせず停止しました。",
      );
    }
    return "EXISTS";
  }
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, ".staging-"));
  try {
    await writeFile(path.join(staging, SCHEDULE_FILE), parsed.normalizedCsv, "utf8");
    await writeFile(
      path.join(staging, MANIFEST_FILE),
      JSON.stringify(parsed.manifest, null, 2) + "\n",
      "utf8",
    );
    try {
      await rename(staging, directory);
    } catch (error) {
      // 並行して同じ版が書かれた可能性。内容アドレスなので同じ内容のはず。照合して受け入れる。
      const raced = await readRevision(root, connectionId, parsed.sourceRevision);
      if (raced === "NOT_FOUND" || raced.normalizedCsv !== parsed.normalizedCsv) throw error;
      return "EXISTS";
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return "WRITTEN";
}

/** 取込み：CSVと範囲宣言を検査し、管理版として保存する。DBの正式版参照は作らない。 */
export async function importRevision(
  root: string,
  connectionId: string,
  input: { csv: string; manifest: unknown },
): Promise<{ parsed: MonthlyCsv; stored: "WRITTEN" | "EXISTS" }> {
  const parsed = parseMonthlyCsv(input.csv, input.manifest);
  const stored = await writeRevision(root, connectionId, parsed);
  return { parsed, stored };
}

/** `applyUpdate` の記録。照会（`getUpdateResult`）と再生はこれを読む。 */
export interface StoredCsvOperation {
  readonly connectionId: string;
  readonly operationId: string;
  readonly requestHash: RequestHash;
  readonly result: UpdateResult;
  readonly recordedAt: string;
}

export async function readOperationRecord(
  root: string,
  connectionId: string,
  operationId: string,
): Promise<StoredCsvOperation | "NOT_FOUND"> {
  const text = await readTextIfExists(operationFile(root, connectionId, operationId));
  if (text === undefined) return "NOT_FOUND";
  const record = JSON.parse(text) as StoredCsvOperation;
  // ディレクトリ名の写像は一意ではない。記録側のIDと照合する。
  if (record.connectionId !== connectionId || record.operationId !== operationId) {
    return "NOT_FOUND";
  }
  return record;
}

/** 記録を書く。一時ファイルへ書いて rename する（半端な記録を残さない）。 */
export async function writeOperationRecord(
  root: string,
  record: StoredCsvOperation,
): Promise<void> {
  const file = operationFile(root, record.connectionId, record.operationId);
  await mkdir(path.dirname(file), { recursive: true });
  const staging = `${file}.staging-${process.pid}-${Date.now()}`;
  await writeFile(staging, JSON.stringify(record, null, 2) + "\n", "utf8");
  await rename(staging, file);
}

/** この接続をストアが知っているか（取込み済みか）。照会経路の有無の判断に使う。 */
export async function connectionKnown(root: string, connectionId: string): Promise<boolean> {
  return (
    (await readTextIfExists(path.join(connectionRoot(root, connectionId), ".connection"))) !==
    undefined
  );
}

/** 接続の根を作り、元の接続IDを記録する。取込み時に一度呼ぶ。 */
export async function registerConnection(root: string, connectionId: string): Promise<void> {
  const directory = connectionRoot(root, connectionId);
  await mkdir(path.join(directory, "revisions"), { recursive: true });
  await mkdir(path.join(directory, "operations"), { recursive: true });
  await writeFile(path.join(directory, ".connection"), `${connectionId}\n`, "utf8");
}

export type BuiltUpdate =
  | { readonly ok: true; readonly csv: string; readonly manifest: CsvManifest }
  | { readonly ok: false; readonly detail: string };

function sameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

/**
 * 管理版に更新内容を重ねて、次の版の入力（CSVと範囲宣言）を作る。**純粋関数。**
 *
 * ここでは書かない。返した入力を `parseMonthlyCsv` に通すと、列の形式・スタッフ・職種・
 * 15分刻み・最長4時間・月内完全性が検査され、次の `sourceRevision` が決まる。
 *
 * 断る条件（いずれも外部作用の前）：
 *   - 欠勤にする勤務が無い、予定済みでない、区間が元勤務と一致しない（Q04：全時間欠勤）
 *   - 追加勤務のIDが既にある（RFC-010 §3：再試行で作り直さない前提が破れている）
 *   - 追加勤務の営業日が範囲宣言に無い（欠けた日へ勤務を足さない：Q06）
 */
interface MutableRow {
  scheduleId: string;
  businessDate: string;
  shiftAssignmentId: string;
  staffId: string;
  roleCode: string;
  startAt: string;
  endAt: string;
  status: AssignmentStatus;
  sourceCaseId?: string;
}

export function buildUpdatedInput(base: MonthlyCsv, command: ApplyUpdateCommand): BuiltUpdate {
  const rows: MutableRow[] = base.assignments.map((row) => ({ ...row }));
  const manifest = structuredClone(base.manifest) as CsvManifest;
  if (!manifest.days) {
    return {
      ok: false,
      detail: "範囲宣言に営業日がありません。追加勤務の勤務表IDを決められません。",
    };
  }
  const byId = new Map(rows.map((row) => [row.shiftAssignmentId, row] as const));

  for (const absence of command.absences) {
    const row = byId.get(absence.shiftAssignmentId.toLowerCase());
    if (!row) return { ok: false, detail: "欠勤にする勤務が管理版にありません。" };
    if (row.status !== "SCHEDULED") {
      return { ok: false, detail: `欠勤にする勤務が予定済みではありません（${row.status}）。` };
    }
    if (!sameInstant(row.startAt, absence.startAt) || !sameInstant(row.endAt, absence.endAt)) {
      return { ok: false, detail: "欠勤区間が元勤務と一致しません。部分欠勤は範囲外です（Q04）。" };
    }
    row.status = "ABSENT";
  }

  for (const addition of command.additions) {
    const id = addition.shiftAssignmentId.toLowerCase();
    if (byId.has(id)) return { ok: false, detail: "追加勤務のIDが既に管理版にあります。" };
    let startAt: string;
    let endAt: string;
    try {
      startAt = toJstFixedFormat(addition.startAt);
      endAt = toJstFixedFormat(addition.endAt);
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "追加勤務の日時を解釈できません。",
      };
    }
    const businessDate = startAt.slice(0, 10);
    const day = manifest.days.find((d) => d.date === businessDate);
    if (!day) {
      return { ok: false, detail: `追加勤務の営業日（${businessDate}）が範囲宣言にありません。` };
    }
    const row: MutableRow = {
      scheduleId: day.scheduleId,
      businessDate,
      shiftAssignmentId: id,
      staffId: addition.staffId.toLowerCase(),
      roleCode: addition.roleCode,
      startAt,
      endAt,
      status: "SCHEDULED",
      sourceCaseId: addition.sourceCaseId.toLowerCase(),
    };
    rows.push(row);
    byId.set(id, row);
    day.assignmentIds = [...day.assignmentIds, id];
  }

  const csv =
    [
      CSV_COLUMNS.join(","),
      ...rows.map((row) => CSV_COLUMNS.map((key) => row[key] ?? "").join(",")),
    ].join("\n") + "\n";
  return { ok: true, csv, manifest };
}
