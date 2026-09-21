import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // 実DBを使う統合テストがあるため、既定はnode環境。
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // e2eはPlaywright導入後に別コマンドへ分ける。
    exclude: ["tests/e2e/**", "node_modules/**"],
    // **テストファイルを並行実行しない。**
    //
    // 統合テストは1つのDBを共有する。worker相当の処理（未処理の返信の取り出し）は
    // 案件や接続で絞らず、最も古い未処理の受信を取る——実運用では1店舗・1workerなので
    // 正しいが、テストを並行させると別ファイルが作った受信を拾い合う。
    // 実際に、受信のテストが作ったイベントを解釈のテストが処理してしまった。
    //
    // 単体テストは速いので、分けずに全体を直列にする。
    fileParallelism: false,
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
