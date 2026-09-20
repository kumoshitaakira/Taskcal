import { describe, expect, it } from "vitest";
import {
  MODEL_OUTPUT_SCHEMA_VERSION,
  modelReplyOutputJsonSchema,
  modelReplyOutputSchema,
} from "@/contracts/model-output";

describe("モデル出力の契約（RFC-011 §3 / ADR-004）", () => {
  it("検査に使うschemaからJSON Schemaを生成する（手書きの形式説明と食い違わせない）", () => {
    const schema = modelReplyOutputJsonSchema();
    expect(schema).toMatchObject({ type: "object" });

    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["interpretation", "proposedAction"]);

    const interpretation = (properties.interpretation as { properties: Record<string, unknown> })
      .properties;
    // 承諾の判定に必要な項目がモデルへ伝わること。
    expect(Object.keys(interpretation).sort()).toEqual([
      "evidenceSpans",
      "extractionRuleVersion",
      "intent",
      "offeredRanges",
      "unresolvedConditions",
    ]);
  });

  it("schema版を固定する（prompt・モデルIDと併せて版管理する）", () => {
    expect(MODEL_OUTPUT_SCHEMA_VERSION).toBe("reply-interpretation/0.1.0-draft");
  });

  it("許可していない次行動を受け付けない", () => {
    const base = {
      interpretation: {
        extractionRuleVersion: "v1",
        intent: "ACCEPT",
        offeredRanges: [
          { startAt: "2026-09-21T18:00:00+09:00", endAt: "2026-09-21T22:00:00+09:00" },
        ],
        unresolvedConditions: [],
        evidenceSpans: [],
      },
    };
    expect(modelReplyOutputSchema.safeParse({ ...base, proposedAction: "NO_ACTION" }).success).toBe(
      true,
    );
    // 勤務の確定をモデルに提案させない。
    expect(
      modelReplyOutputSchema.safeParse({ ...base, proposedAction: "ADOPT_SCHEDULE" }).success,
    ).toBe(false);
  });

  it("未知のintentを承諾として通さない", () => {
    const parsed = modelReplyOutputSchema.safeParse({
      interpretation: {
        extractionRuleVersion: "v1",
        intent: "PROBABLY_YES",
        offeredRanges: [],
        unresolvedConditions: [],
        evidenceSpans: [],
      },
      proposedAction: "NO_ACTION",
    });
    expect(parsed.success).toBe(false);
  });
});
