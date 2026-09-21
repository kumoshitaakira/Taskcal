import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` は AGENTS.md へ独自の案内を追記する。AGENTS.md はこのリポジトリの
  // 指示の正本（CLAUDE.md）なので、フレームワークに書き換えさせない。
  agentRules: false,
};

export default nextConfig;
