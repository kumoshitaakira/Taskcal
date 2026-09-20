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

/** 返信から読み取った勤務意思。曖昧なものを承諾へ寄せない。 */
export const replyIntentSchema = z.enum([
  /** 提示条件で勤務する意思がある。 */
  "ACCEPT",
  /** 勤務しない。辞退理由は求めない（ADR-008）。 */
  "DECLINE",
  /** 条件付き。一意に決まらないため追加確認が必要。 */
  "CONDITIONAL",
  /** 以前の回答の訂正。 */
  "CORRECTION",
  /** 以前の回答の撤回。 */
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
    .array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }))
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

export type ModelReplyOutput = z.infer<typeof modelReplyOutputSchema>;

/** schema版。プロンプトと併せて版管理する（RFC-004 §末尾）。 */
export const MODEL_OUTPUT_SCHEMA_VERSION = "reply-interpretation/0.1.0-draft";
