# src/domain

ドメイン規則。**DB・Next.js・モデルSDKをimportしない**（RFC-003 §3）。

テストのため `Clock`、`IdGenerator`、`ModelGateway`、`MessageChannel` を差し替え
可能にする。

| 配下         | 主担当                        |
| ------------ | ----------------------------- |
| `interval/`  | B（時間区間、重複、充足計算） |
| `selection/` | B（候補評価、勤務計画の選定） |

コード所有は排他的な編集権ではなく、設計・完了・説明の責任を示す（ADR-021）。
