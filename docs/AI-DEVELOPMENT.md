# AI開発ガイド

TaskcalではCodexを主系にし、Claude Codeからも同じ設計判断とワークフローを利用できるようにする。

## 構成

| パス | 用途 |
|---|---|
| `AGENTS.md` | Codexが常時読む正本。プロダクト境界、設計の優先順位、不変条件、検証方針 |
| `CLAUDE.md` | Claude Code用の入口。`AGENTS.md`を読み込み、正本の重複を避ける |
| `.agents/skills/` | Codex用かつツール共通のスキル正本 |
| `.claude/skills/` | `.agents/skills/`へのリンク。Claude Codeから同じスキルを利用するための入口 |
| `.codex/agents/` | Codexの読み取り専用レビューエージェント |
| `.claude/agents/` | 同じ役割を持つClaude Code形式のレビューエージェント |

## スキル

| 名前 | Codex | Claude Code | 用途 |
|---|---|---|---|
| `taskcal-implement` | `$taskcal-implement` | `/taskcal-implement` | 機能を縦に実装し、決定的な検査・復旧・受入ケースまで揃える |
| `taskcal-record-decision` | `$taskcal-record-decision` | `/taskcal-record-decision` | ADR・RFC・未決事項・受入条件を一貫して更新する |
| `taskcal-review-change` | `$taskcal-review-change` | `/taskcal-review-change` | 変更をドメイン、安全性、冪等性、費用、4日MVPの観点でレビューする |

通常は自然文の依頼内容から必要なスキルが選ばれる。明示したい場合は上記の名前で呼び出す。

## レビューエージェント

| 名前 | 主な確認範囲 |
|---|---|
| `taskcal-domain-reviewer` | 同意、時間、状態遷移、CSV正式採用、競合、再試行、古いAI結果 |
| `taskcal-delivery-reviewer` | 4日MVP、セキュリティ、費用、UX、実演可能性、A01〜A18の証拠 |

主エージェントが実装と統合を担当し、レビューエージェントはファイルを変更しない。レビュー結果は主エージェントが確認し、必要な修正と再検証を行う。

## 使い始める

リポジトリのルートからCodexまたはClaude Codeを開始する。新規に追加したスキルやエージェントが一覧へ出ない場合は、セッションを再起動する。

依頼例：

```text
$taskcal-implement A03を満たす正式採用後の応答喪失リカバリーを実装して
$taskcal-record-decision Q01を方式Aで決定し、関連文書を更新して
taskcal-domain-reviewerで現在のPRをレビューして
```

Claude Codeではスキルの先頭を `/` に置き換える。

実装がまだ存在しない現時点では、ビルド・テストコマンドは定義していない。アプリケーション基盤を追加した変更で、ルートREADMEと本書へ実際のコマンドを追記する。
