/**
 * DBトランザクション境界。
 *
 * 出典：RFC-010 §5、ADR-006。
 *
 * 規則：
 *   - 外部API待ちやCSV生成をトランザクションの内側に置かない。
 *     ファイルを先に完全保存・検査し、内部の正式採用を後に置く（RFC-010 §4）。
 *   - ファイルシステムとDBを一つの通常のDB取引にできると仮定しない。
 *   - 正式採用は、正式版参照・内部勤務表・採用済み計画・案件の確定事実・
 *     操作結果・通知待ちを **同じ取引** で保存する（RFC-010 §4 手順6）。
 *   - **入れ子にしない。** 入れ子で呼ぶとプールから別のclientを取り、一括採用が
 *     黙って2つの取引に割れる（D06／A08）。`Tx` は引数で引き回すこと。
 *     ここでは AsyncLocalStorage で検出して、同じ `Tx` を再利用する。
 */

import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
import { getPool } from "./pool";

export type Tx = PoolClient;

export interface TransactionOptions {
  /** 既定は read committed。A04の検証で必要なら上げる。 */
  readonly isolationLevel?: "read committed" | "repeatable read" | "serializable";
  /**
   * ロック待ちの上限。無指定だと無言で永久待機する。
   * ADR-006 の順序どおりロックしても、待ち上限が無いと停止を検知できない。
   */
  readonly lockTimeoutMs?: number;
}

const currentTx = new AsyncLocalStorage<Tx>();

export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const existing = currentTx.getStore();
  if (existing) {
    // 入れ子呼出し。新しい取引を開かず、外側の取引へ参加する。
    // 別clientを取ると一括性が失われる。
    return fn(existing);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (options.isolationLevel) {
      await client.query(`set transaction isolation level ${options.isolationLevel}`);
    }
    if (options.lockTimeoutMs !== undefined) {
      // SET はパラメーターを取れない（`set lock_timeout = $1` は 42601）。
      // 文字列連結でSQLを組まないため、set_config(..., is_local => true) を使う。
      await client.query("select set_config('lock_timeout', $1, true)", [
        `${options.lockTimeoutMs}ms`,
      ]);
    }
    const result = await currentTx.run(client, () => fn(client));
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch {
      // ROLLBACK自体が失敗した接続は壊れている。プールへ戻さず破棄する。
      // ROLLBACKの失敗で元のエラーを隠さない。
      client.release(true);
    }
    throw error;
  }
}

/**
 * 取引の外でだけ行ってよい処理の前に置く。
 *
 * `withTransaction` は入れ子を検出して外側の取引へ合流する。これは一括性を守るため
 * だが、副作用として「取引の内側からモデル呼出しや送信を呼んでも動いてしまう」。
 * その場合、HTTP待ちのあいだ案件行のロックを保持し続け、同時に届いた他の返信が
 * 止まる（RFC-010 §5：外部API待ちやCSV生成中に長いDB取引を保持しない）。
 *
 * 型では表せないため、外部作用の入口で明示的に検査する。
 */
export function assertOutsideTransaction(label: string): void {
  if (currentTx.getStore()) {
    throw new TaskcalError(
      ERROR_CODES.INVALID_INPUT,
      `${label}は取引の外で行ってください（外部待ちの間ロックを保持しない：RFC-010 §5）`,
    );
  }
}
