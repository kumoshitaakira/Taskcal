/**
 * 接続情報が無いときの ModelGateway。
 *
 * 2026-09-21時点でOrcaRouterのAPIキー・接続先・単価は未取得（docs/OPEN-QUESTIONS.md
 * 「外部情報の確認」）。ここで疑似的な解釈結果を返すと、動いていない機能を動いて
 * いるように見せることになるため、明示的に失敗させる。
 */

import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import type { InterpretReplyResponse, ModelGateway } from "./model-gateway";

export class UnconfiguredModelGateway implements ModelGateway {
  isConfigured(): boolean {
    return false;
  }

  async interpretReply(): Promise<InterpretReplyResponse> {
    throw new TaskcalError(
      ERROR_CODES.NOT_CONFIGURED,
      "OrcaRouterの接続情報が未設定です。実推論は行いません（模擬結果も返しません）。",
    );
  }
}
