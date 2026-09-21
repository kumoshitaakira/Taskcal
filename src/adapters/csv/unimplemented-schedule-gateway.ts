/**
 * `ScheduleGateway` の未実装の口。**暫定。担当Bの実装が入ったら消す。**
 *
 * 置いた理由：正式採用の進行（`src/application/adopt-plan.ts`）は Gateway に対して
 * 書いてあるが、CSVの生成・読戻し・正式版接続（`src/adapters/csv/`、担当B）はまだ無い。
 * 合成の根（`src/application/deps.ts`）に fake を入れると、動いていないものが画面で
 * 動いて見える。`UnconfiguredModelGateway` と同じ方針で、**模擬結果を返さず
 * `NOT_IMPLEMENTED` を投げる**。
 *
 * `capabilities` は全て false。「できない」と宣言しておかないと、呼出し側が期待版検査や
 * 結果照会が効いていると仮定して分岐する。
 *
 * 担当Bの `ScheduleGateway` が入ったら、この implementation を `deps.ts` から外して
 * ファイルごと削除し、`runtime-status` の `notImplemented` から該当行を落とす。
 */

import "server-only";
import { ERROR_CODES, TaskcalError } from "../../contracts/errors";
import type { ScheduleGateway, SourceCapabilities } from "../../contracts/schedule-gateway";

const NOT_IMPLEMENTED: SourceCapabilities = {
  canReadRevision: false,
  canConditionalUpdate: false,
  supportsIdempotencyKey: false,
  supportsResultLookup: false,
  supportsAtomicBatch: false,
};

function refuse(operation: string): never {
  throw new TaskcalError(
    ERROR_CODES.NOT_IMPLEMENTED,
    `${operation} は未実装です（CSVの取込み・生成・読戻しは担当B）。正式採用へ進めません。`,
  );
}

export function createUnimplementedScheduleGateway(): ScheduleGateway {
  return {
    capabilities: NOT_IMPLEMENTED,
    loadSchedule: () => refuse("勤務表の読込み"),
    applyUpdate: () => refuse("勤務表の更新"),
    getUpdateResult: () => refuse("更新結果の照会"),
    readBack: () => refuse("成果物の読戻し"),
  };
}
