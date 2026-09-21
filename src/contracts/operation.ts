/**
 * 状態変更操作の識別と照合。
 *
 * 出典：ADR-006、RFC-009 D07、RFC-010 §3。
 *
 * 規則：
 *   - 同じ operationId で内容が異なる要求は拒否する。
 *   - 同じ operationId で内容が同じ要求は、保存済み結果を返すか照合する。
 *   - 追加勤務IDを再試行で作り直さない。
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { ERROR_CODES, TaskcalError } from "./errors";

/** 安定した操作ID。呼出し元が決め、再試行でも変えない。 */
export const operationIdSchema = z.string().min(1).max(128);
export type OperationId = z.infer<typeof operationIdSchema>;

/** 固定した要求内容のハッシュ。 */
export const requestHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type RequestHash = z.infer<typeof requestHashSchema>;

/**
 * 要求内容から requestHash を作る。
 *
 * 正規化の規則：
 *   - オブジェクトのキー順で結果を変えない。キー順の違いを内容の違いにしない。
 *   - **配列は順序に意味があるものとして扱う。** CSVの行順が変わっても同じ内容として
 *     扱いたい集合（例：ApplyUpdateCommand.additions）は、呼出し側が安定IDで整列
 *     してから渡す（A06）。
 *   - 素のオブジェクト・配列・プリミティブ以外は**拒否する**。Date・Map・Setは
 *     own enumerable property を持たないため、展開すると内容の異なる値が同じ
 *     結果になる。`{start: 18時}` と `{start: 22時}` が同一hashになると、
 *     ADR-006／D07 が最も危険な向き（別内容の要求をREPLAY扱い）に破れる。
 *     時刻はISO 8601文字列にしてから渡すこと。
 *   - undefined と null を区別する。NaN・Infinity・BigInt・循環参照は拒否する。
 */
export function computeRequestHash(payload: unknown): RequestHash {
  return createHash("sha256").update(canonicalize(payload, new Set())).digest("hex");
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === undefined) return "\u0000undefined";
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TaskcalError(
          ERROR_CODES.INVALID_INPUT,
          "NaN・Infinity は要求内容に含められません。",
        );
      }
      return JSON.stringify(value);
    case "bigint":
    case "symbol":
    case "function":
      throw new TaskcalError(
        ERROR_CODES.INVALID_INPUT,
        `${typeof value} は要求内容に含められません。`,
      );
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TaskcalError(ERROR_CODES.INVALID_INPUT, "循環参照は要求内容に含められません。");
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => canonicalize(item, seen)).join(",")}]`;
    }

    // 素のオブジェクト以外（Date, Map, Set, class インスタンス等）は拒否する。
    // 展開すると内容が消えて別の値と同じ結果になるため、黙って通さない。
    const proto: unknown = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      throw new TaskcalError(
        ERROR_CODES.INVALID_INPUT,
        `${object.constructor?.name ?? "この型"} は要求内容に含められません。` +
          "時刻はISO 8601文字列、集合は配列へ変換してから渡してください。",
      );
    }

    const entries = Object.entries(object as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v, seen)}`).join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/** 保存済み操作との照合結果。 */
export const OPERATION_MATCH = {
  /** 未実行。新規に進めてよい。 */
  NEW: "NEW",
  /** 同じ内容で実行済み。保存済み結果を返す。 */
  REPLAY: "REPLAY",
  /** 同じIDで内容が異なる。拒否する。 */
  CONFLICT: "CONFLICT",
} as const;

export type OperationMatch = (typeof OPERATION_MATCH)[keyof typeof OPERATION_MATCH];

export const operationRefSchema = z.object({
  operationId: operationIdSchema,
  requestHash: requestHashSchema,
});

export type OperationRef = z.infer<typeof operationRefSchema>;
