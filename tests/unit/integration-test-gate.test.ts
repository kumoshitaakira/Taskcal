import { describe, expect, it } from "vitest";
import {
  hasDatabaseUrl,
  integrationTestMode,
  isCiEnvironment,
} from "../../scripts/integration-test-gate";

describe("integration test gate", () => {
  it("CIではDATABASE_URL欠落をskipではなく失敗モードにする", () => {
    const env = { CI: "true" };

    expect(isCiEnvironment(env)).toBe(true);
    expect(hasDatabaseUrl(env)).toBe(false);
    expect(integrationTestMode(env)).toBe("ci-missing-database-url");
  });

  it("ローカルではDATABASE_URL欠落を従来どおりskip可能にする", () => {
    expect(integrationTestMode({})).toBe("local-skip");
  });

  it("DATABASE_URLがあればCIでも実行モードにする", () => {
    expect(integrationTestMode({ CI: "true", DATABASE_URL: "postgres://localhost/taskcal" })).toBe(
      "run",
    );
  });

  it("空白だけのDATABASE_URLを未設定として扱う", () => {
    expect(integrationTestMode({ DATABASE_URL: "  " })).toBe("local-skip");
  });
});
