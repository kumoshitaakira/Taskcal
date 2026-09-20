# Claude Code project instructions

@AGENTS.md

## Claude Code compatibility

`AGENTS.md` is the canonical project guidance. Do not maintain a separate copy of its rules here.

Project skills are authored once under `.agents/skills/` and exposed to Claude Code through `.claude/skills/` symlinks. Invoke them as `/taskcal-implement`, `/taskcal-record-decision` and `/taskcal-review-change` when useful.

Project subagents live under `.claude/agents/`. The main conversation owns all edits and integration. Use the Taskcal reviewers for bounded, read-only review work and return their findings to the main conversation.
