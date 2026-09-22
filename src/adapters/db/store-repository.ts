/**
 * 店舗の文脈の読み取り。
 *
 * 表示と月境界は `timezone` に従う（RFC-009 §5）。MVPは架空の1店舗・1職種で、
 * 外部入力の店舗IDを信用せず、呼出し元が渡したIDで引く（ADR-008）。
 */

import "server-only";
import type { StoreRepository, StoreSnapshot, TxHandle } from "../../contracts/repository";
import type { Tx } from "./transaction";

export function createPgStoreRepository(): StoreRepository {
  return {
    async findById(handle: TxHandle, storeId: string) {
      const tx = handle as Tx;
      const { rows } = await tx.query<{ name: string; timezone: string; role_code: string }>(
        "select name, timezone, role_code from store where store_id = $1",
        [storeId],
      );
      const row = rows[0];
      if (!row) return "NOT_FOUND" as const;
      const snapshot: StoreSnapshot = {
        storeId,
        name: row.name,
        timezone: row.timezone,
        roleCode: row.role_code,
      };
      return snapshot;
    },
  };
}
