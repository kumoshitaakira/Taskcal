/**
 * モデル出力の契約（下書き）。
 *
 * 出典：RFC-011 §3、ADR-004、ADR-014。対応文型の幅は **Q09未決**。
 *
 * 境界（AGENTS.md、ADR-004）:
 *   - モデルは返信解釈と、許可した次行動の提案だけを行う。
 *   - 本人確認、認可、候補適格性、時間、承諾、上限、予算、状態遷移は
 *     決定的なコードで検査する。モデル出力はその入力に過ぎない。
 *   - 自己申告 confidence を同意の証拠にしない（RFC-011 §3）。
 *   - 外部の返信は引用されたデータとして扱い、system指示と同じ権限を与えない。
 */

import { z } from "zod";

/**
 * 返信から読み取った勤務意思。曖昧なものを承諾へ寄せない。
 *
 * **判定対象は返信単体ではない（Q09）。** 元打診、現在の承諾、確定前か確定後かを
 * 併せて判定する。「19時から」だけでも、元打診の終了時刻から条件が一意に定まるなら
 * 承諾候補になり得る。逆に、対象が一意でなければ文型が明快でも承諾にしない。
 *
 * **「承諾として採用しない」ことと「返信を無視する」ことは別。** 承諾に使えない返信も
 * 記録し、辞退・撤回・保留として状態へ反映する（RFC-011 §4）。
 */
export const replyIntentSchema = z.enum([
  /** 提示条件で勤務する意思がある。 */
  "ACCEPT",
  /**
   * 勤務しない。辞退理由は求めない（ADR-008）。
   * 対象が一意なら、時刻の再記載が無くても辞退として処理する（Q09）。
   */
  "DECLINE",
  /**
   * 条件付き。元打診と併せても一意に決まらないため追加確認が必要。
   */
  "CONDITIONAL",
  /**
   * 以前の回答の訂正。
   * 曖昧な訂正は確認へ回し、**旧承諾による選定も保留する**（Q09 / RFC-011 §4）。
   */
  "CORRECTION",
  /**
   * 以前の回答の撤回。対象が一意なら、時刻の再記載が無くても処理する（Q09）。
   */
  "WITHDRAW",
  /** 勤務意思として読み取れない。 */
  "UNCLEAR",
]);

export type ReplyIntent = z.infer<typeof replyIntentSchema>;

/**
 * 返信の解釈。版を付けて保存し、どの解釈を採用したか追跡する（RFC-009 §3）。
 *
 * 時刻は「返信から読み取れた値」であり、提示範囲・可能時間・月次上限・期限を
 * 満たすかはコード側で検査する。
 */
export const replyInterpretationSchema = z.object({
  /** 抽出規則の版。プロンプト・schema・モデルIDと併せて記録する（RFC-004）。 */
  extractionRuleVersion: z.string().min(1),
  intent: replyIntentSchema,
  /**
   * 読み取れた勤務可能区間。半開区間 [start, end)。
   * Q03（分断された空き時間）が範囲外のままなら、複数区間はコード側で拒否する。
   */
  offeredRanges: z
    .array(
      z.object({
        startAt: z.string().min(1),
        endAt: z.string().min(1),
      }),
    )
    .max(4),
  /** 未解決の条件。空でなければ承諾として成立させない。 */
  unresolvedConditions: z.array(z.string().max(200)).max(5),
  /**
   * 根拠として引用した原文の位置。原文そのものを不要に複製しない（AGENTS.md）。
   */
  evidenceSpans: z
    .array(
      z
        .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
        // 逆転した範囲を根拠として受け取らない。採用解釈の追跡ができなくなる。
        .refine((span) => span.end >= span.start, {
          message: "end は start 以上である必要があります。",
        }),
    )
    .max(5),
});

export type ReplyInterpretation = z.infer<typeof replyInterpretationSchema>;

/**
 * モデルが提案してよい次行動。ここに無い行動は提案させない。
 * 提案は提案であり、実行の可否はコードが決める。
 */
export const proposedActionSchema = z.enum([
  "ASK_CLARIFICATION",
  "RECORD_DECLINE",
  "RECORD_COMMITMENT_CANDIDATE",
  "HANDOFF_TO_MANAGER",
  "NO_ACTION",
]);

export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const modelReplyOutputSchema = z.object({
  interpretation: replyInterpretationSchema,
  proposedAction: proposedActionSchema,
});

/**
 * 解釈のfixtureが揃えるべき入力（Q09）。
 *
 * 例文だけのfixtureにしない。元打診、既存の承諾、確定前か確定後か、期待結果を
 * セットにする。同じ文面でも、確定前なら再計画、確定後なら人への引き継ぎになる
 * （RFC-011 §4の表）。
 */
export interface ReplyFixtureInput {
  readonly offer: {
    readonly date: string;
    readonly roleCode: string;
    readonly startAt: string;
    readonly endAt: string;
    readonly deadlineAt: string;
  };
  /** この返信の時点で、このスタッフに有効な承諾があるか。 */
  readonly existingCommitment?: { readonly startAt: string; readonly endAt: string };
  /** 案件がすでに正式採用済みか。確定前後で扱いが変わる。 */
  readonly afterCommit: boolean;
  readonly replyText: string;
}

export type ModelReplyOutput = z.infer<typeof modelReplyOutputSchema>;

/**
 * 根拠の位置が、対象本文に収まっているか検査する（RFC-004 §3）。
 *
 * `evidenceSpans` は**モデルへ渡した本文**（マスク後）のインデックス。原文へ
 * そのまま当てない。schema側では `end >= start` しか見られないため、本文長との
 * 突き合わせはここで行う。解釈を永続化する直前に必ず通す。
 */
export function validateEvidenceSpans(
  interpretation: ReplyInterpretation,
  maskedReplyText: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  for (const span of interpretation.evidenceSpans) {
    if (span.end > maskedReplyText.length) {
      return { ok: false, reason: "根拠の位置が本文の範囲を超えています。" };
    }
  }

  // 意味を読み取ったと言う以上、本文のどこを根拠にしたかを示させる。
  // 空配列や長さ0のspanを通すと、根拠の無い ACCEPT が採用解釈として保存され、
  // 後から「なぜその条件だと判断したか」を説明できない（RFC-004 §3、D03）。
  // UNCLEAR は「読み取れなかった」という結論なので、根拠を要求しない。
  if (interpretation.intent !== "UNCLEAR") {
    const hasNonEmpty = interpretation.evidenceSpans.some((span) => span.end > span.start);
    if (!hasNonEmpty) {
      return { ok: false, reason: "意思を読み取った根拠が示されていません。" };
    }
  }
  return { ok: true };
}

/**
 * 永続化する解釈（RFC-011 §4）。
 *
 * モデル出力そのものには `staffId` を持たせない（D03）。採用時の追跡に必要な
 * 紐づけは、この型で持つ。これが無いとA12（遅れて返った結果で新しい承諾を
 * 過去の状態へ戻さない）をコード側で判定できない。
 */
export interface PersistedReplyInterpretation {
  readonly interpretationId: string;
  /** 解釈の対象になった不変のMessage。 */
  readonly messageId: string;
  /** 案件内の受信順。モデル処理の完了順ではない。 */
  readonly receivedSeq: number;
  /** 解釈した時点の案件版。古い結果を新しい状態へ適用しないため。 */
  readonly caseVersion: number;
  /** この解釈を生んだモデル呼出し（RFC-004 §8 の `request_id`）。 */
  readonly requestId: string;
  readonly output: ModelReplyOutput;
  /**
   * モデルへ渡した本文（マスク後）。`output` の `evidenceSpans` はこの座標系。
   * 原文を保存する場合も、根拠の突き合わせはこちらで行う。
   */
  readonly maskedReplyText: string;
}

/** schema版。プロンプトと併せて版管理する（RFC-004 §末尾）。 */
export const MODEL_OUTPUT_SCHEMA_VERSION = "reply-interpretation/0.1.0-draft";

/**
 * モデルへ渡すJSON Schema。
 *
 * 検査に使う zod schema から生成する。プロンプト側に手書きの形式説明を置くと、
 * 検査側と食い違ったときにモデルが拒否され続け、費用だけを消費する。
 */
export function modelReplyOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(modelReplyOutputSchema) as Record<string, unknown>;
}
