import { describe, expect, it } from "vitest";
import { maskContactInfo } from "@/adapters/orca/mask";

describe("送信前のマスク（RFC-004 §5 / ADR-008）", () => {
  it("連絡先らしき並びを置き換える", () => {
    expect(maskContactInfo("080-1234-5678 に連絡ください").text).toBe("[電話番号] に連絡ください");
    expect(maskContactInfo("taro@example.com へ送って").text).toBe("[メールアドレス] へ送って");
    expect(maskContactInfo("https://example.com/abc を見て").text).toBe("[URL] を見て");
    expect(maskContactInfo("LINE ID: taro_123 です").text).toBe("[アカウントID] です");
  });

  it("区切りのない電話番号と国番号つきも対象にする", () => {
    const r = maskContactInfo("09012345678 と +81-90-1234-5678");
    expect(r.text).toBe("[電話番号] と [電話番号]");
    expect(r.summary.phone).toBe(2);
  });

  it("表記ゆれのある連絡先も拾う", () => {
    expect(maskContactInfo("03-1234-5678").text).toBe("[電話番号]");
    expect(maskContactInfo("taro＠example.com").text).toBe("[メールアドレス]");
    expect(maskContactInfo("ライン taro_123").text).toBe("[アカウントID]");
    expect(maskContactInfo("@taro_123").text).toBe("[アカウントID]");
  });

  it("勤務条件の時刻・日付を壊さない（過剰なマスクは解釈を壊す）", () => {
    for (const text of [
      "18:00から22:00まで大丈夫です",
      "19時からなら行けます",
      "9/21は無理です",
      "0930から入れます",
      "0時から4時まで",
      "2026-09-21 の18-22時",
      // NNNN-NNNN の範囲表記。桁数で絞らないと電話番号として消える。
      "0900-1730 なら大丈夫です",
      "1700-2200 で入れます",
      "1月2日 0900-1730",
      "9:00-17:30 で",
      // 電話番号ではない数字列。
      "従業員番号 0012345",
      "〒060-0001",
    ]) {
      const r = maskContactInfo(text);
      expect(r.masked, text).toBe(false);
      expect(r.text).toBe(text);
    }
  });

  /**
   * 過剰マスクの回帰検査。
   *
   * 電話番号・URLの順に、同じ「後続の日本語まで取り込む」欠陥を2回作った。
   * ルールを足したら必ずここへ勤務条件つきの例を足すこと。
   */
  it("どのルールも、直後に続く勤務条件を巻き込まない", () => {
    const cases: [string, string][] = [
      // [入力, マスク後に必ず残っていてほしい部分]
      ["詳細はhttps://example.com。18時から22時まで入れます", "18時から22時まで入れます"],
      ["https://example.com、19時からなら行けます", "19時からなら行けます"],
      ["（https://example.com）を見て", "を見て"],
      ["https://x.test/a です。19時から", "です。19時から"],
      ["080-1234-5678 です。19時から行けます", "です。19時から行けます"],
      ["taro@example.com。18時から", "。18時から"],
      ["LINE ID: taro_123。19時から", "。19時から"],
      ["@taro_123 19時から行けます", "19時から行けます"],
    ];
    for (const [input, mustKeep] of cases) {
      expect(maskContactInfo(input).text, input).toContain(mustKeep);
    }
  });

  it("決定的に動く（同じ入力からは同じ出力）", () => {
    const text = "080-1234-5678 と taro@example.com";
    expect(maskContactInfo(text).text).toBe(maskContactInfo(text).text);
  });

  it("内訳に原文を含めない", () => {
    const r = maskContactInfo("080-1234-5678");
    expect(JSON.stringify(r.summary)).not.toContain("1234");
  });
});
