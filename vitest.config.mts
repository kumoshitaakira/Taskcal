import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // 実DBを使う統合テストがあるため、既定はnode環境。
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // e2eはPlaywright導入後に別コマンドへ分ける。
    exclude: ["tests/e2e/**", "node_modules/**"],
  },
  resolve: {
    alias: {
      "@": path.join(import.meta.dirname, "src"),
    },
  },
});
