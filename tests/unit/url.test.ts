import { describe, expect, it } from "vitest";
import { chatCompletionsUrl } from "@/adapters/orca/orca-client";
import { orcaEnvSchema } from "@/config/env-schema";

describe("chat completions のURL", () => {
  it("base URL が API base 形式でも /v1 を二重に付けない", () => {
    expect(chatCompletionsUrl("https://api.example.com")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.example.com/")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("http://x.test:8080/v1")).toBe(
      "http://x.test:8080/v1/chat/completions",
    );
  });

  it("query や fragment があっても path を正しく組む（文字列連結にしない）", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1?tenant=x")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.example.com/v1#x")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("設定の時点でも query・fragment・資格情報を拒否する", () => {
    for (const bad of [
      "https://api.example.com/v1?tenant=x",
      "https://api.example.com/v1#x",
      "https://user:pass@example.com",
    ]) {
      expect(orcaEnvSchema.safeParse({ ORCA_BASE_URL: bad }).success, bad).toBe(false);
    }
  });
});
