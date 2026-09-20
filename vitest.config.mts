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
      // server-only は「サーバー側だけで使う」ことをビルドへ伝えるための印で、
      // importするとNext以外の環境では例外になる。テストでは無効化する。
      // 印そのものの検査は `npm run build`（クライアント境界の検査）が行う。
      "server-only": path.join(import.meta.dirname, "tests", "stubs", "server-only.ts"),
    },
  },
});
