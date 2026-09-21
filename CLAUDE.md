# Claude Code プロジェクト指示

@AGENTS.md

## Claude Code互換設定

`AGENTS.md`をプロジェクト指示の正本とする。このファイルに同じ規則を複製しない。

プロジェクトスキルの正本は `.agents/skills/` に置き、`.claude/skills/` のシンボリックリンクからClaude Codeへ公開する。必要に応じて `/taskcal-implement`、`/taskcal-record-decision`、`/taskcal-review-change`、`/taskcal-self-review` を呼び出す。

プロジェクトのサブエージェントは `.claude/agents/` に置く。主会話が全ての編集と統合を担当する。Taskcalのレビューエージェントには限定した読み取り専用レビューだけを委譲し、指摘を主会話へ返す。
