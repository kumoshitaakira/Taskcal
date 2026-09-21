import { describe, expect, it } from "vitest";
import { databaseUrlSchema, orcaEnvSchema } from "@/config/env-schema";

describe("環境変数のschema", () => {
  it("ORCA_BASE_URL は絶対HTTP(S) URLだけを受ける", () => {
    // typo が通ると、予約したあと fetch が送信前に失敗し、一度も送っていない
    // 呼出しの照合が必要になる（RFC-004 §7）。
    for (const bad of [
      "orca.example.com",
      "ftp://x.test",
      "/v1",
      "example",
      // Node の fetch は資格情報つきURLを送信前に TypeError で拒否する。
      // 通すと、一度も送っていない呼出しを照合待ちにしてしまう。
      "https://user:pass@example.com",
      "https://user@example.com",
    ]) {
      expect(orcaEnvSchema.safeParse({ ORCA_BASE_URL: bad }).success, bad).toBe(false);
    }
    for (const good of ["https://example.com", "http://x.test:8080/v1"]) {
      expect(orcaEnvSchema.safeParse({ ORCA_BASE_URL: good }).success, good).toBe(true);
    }
  });

  it("空文字と未設定は「未設定」として受ける", () => {
    expect(orcaEnvSchema.safeParse({ ORCA_BASE_URL: "" }).success).toBe(true);
    expect(orcaEnvSchema.safeParse({}).success).toBe(true);
  });

  it("金額・回数は正の整数だけを受ける", () => {
    for (const bad of ["abc", "-1", "0", "1.5"]) {
      expect(orcaEnvSchema.safeParse({ ORCA_CASE_SPEND_LIMIT_MICRO_USD: bad }).success, bad).toBe(
        false,
      );
    }
    expect(orcaEnvSchema.safeParse({ ORCA_CASE_SPEND_LIMIT_MICRO_USD: "500000" }).success).toBe(
      true,
    );
  });

  it("DATABASE_URL は他の項目と独立して検査できる", () => {
    expect(databaseUrlSchema.safeParse("postgres://u:p@127.0.0.1:5433/db").success).toBe(true);
    expect(databaseUrlSchema.safeParse("").success).toBe(false);
  });
});
