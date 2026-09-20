# 出典・確認範囲・未確認事項

2026-09-20追記：最新の設計方針とレビューは[提供資料の索引](references/README.md)に保存した。S01〜S12の外部資料の確認日は下記の2026-09-19で、今回の記録整理に際して全ページを再検証したわけではない。

確認日：2026-09-19。リンク先は更新されるため、実装・契約・課金の前にも再確認する。公開仕様の存在と、利用アカウントでの動作確認は別である。

## 参照資料

| ID | 一次資料・提供資料 | 本資料に反映した内容・限界 |
|---|---|---|
| S01 | [OrcaRouter Routing DSL](https://docs.orcarouter.ai/ja/routing/routing-dsl) | 条件付きルーティング、複数モデル等の公開仕様。アカウント権限・実応答・価格は未確認 |
| S02 | [OrcaRouter Trust](https://www.orcarouter.ai/trust) | 情報処理・保管条件を確認する出発点。証跡地域と上流推論地域を同一視しない |
| S03 | [LINE：Webhookでイベントを受信する](https://developers.line.biz/ja/docs/messaging-api/receiving-messages/) | 署名、再送、イベント重複、順不同、送信取消への対応 |
| S04 | [LINE：失敗したAPIリクエストを再試行する](https://developers.line.biz/ja/docs/messaging-api/retrying-api-request/) | 対応API、X-Line-Retry-Key、有効期限、受付と到達の違い |
| S05 | [LINE公式アカウント料金](https://www.lycbiz.com/jp/service/line-official-account/plan/) ／ [Messaging API料金](https://developers.line.biz/ja/docs/messaging-api/pricing/) | 日本向けプランとカウント対象。送信方式・既存配信・追加枠で費用が変わる |
| S06 | [厚生労働省：いわゆる「シフト制」により就業する労働者の適切な雇用管理を行うための留意事項](https://www.mhlw.go.jp/stf/newpage_22954.html) | シフト運用の専門確認の出発点。個別店舗の法的適合を判定した資料ではない |
| S07 | [PostgreSQL：Range Types](https://www.postgresql.org/docs/current/rangetypes.html) | 半開区間、range・exclusion constraintの考え方。掲載SQLは未実行の設計例 |
| S08 | [Next.js：Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers) | UI/APIを同じアプリに置く技術構成の参考。依存パッケージはDay 1に動作確認して固定 |
| S09 | [Airシフト](https://airregi.jp/shift/) ／ [料金](https://airregi.jp/shift/cost/) | 連携スタッフ1人330円税込などの比較基準。競合に機能がないという断定には使用しない |
| S10 | [元の企画書](https://docs.google.com/document/d/1QBzy0iRmDaJL48Z6yTGGEkUaizDED3lCE9ZFU-AFbyM/edit) | 案05の着想と候補比較の出発点。今回のMVP範囲はユーザーとの会話条件に合わせて具体化 |
| S11 | [共有された第三者レビュー](https://claude.ai/artifact/UkwVYwgpDgZ2zEwH56UkEb) | 収益仮定、自律性、ゲートウェイへの過大依存、個人情報、実測の指摘を反映。事実主張の一次証拠にはしない |
| S12 | この会話でのユーザー回答 | 案05、4日、協力先なし、2人の経験構成。具体言語・稼働時間・予算は未確認 |

## 表記

### 2026-09-20に統合した提供資料

| ID | 資料 | 用途 |
|---|---|---|
| S13 | [MVPスコープ](references/proposal-05-mvp-scope.md) | 目標・範囲の具体化 |
| S14 | [データモデルv0.2](references/proposal-05-data-model-v0.2.md) | 同時打診・自然文承諾への変更 |
| S15 | [データモデルv0.3](references/proposal-05-data-model-v0.3.md) | 集約・値・スナップショットの分類 |
| S16 | [データモデルv0.4](references/proposal-05-data-model-v0.4.md) | Schedule・CSV原本・Gateway・ContactEndpoint |
| S17 | [MVPレビュー](references/proposal-05-mvp-scope-review.md) | 同意・通知・停止・代理指標 |
| S18 | [v0.2レビュー](references/proposal-05-data-model-v0.2-review.md) | 不変条件・状態・時間の反例 |
| S19 | [v0.3レビュー](references/proposal-05-data-model-v0.3-review.md) | 集計・分類・残る判断の整理 |
| S20 | [v0.4レビュー](references/proposal-05-data-model-v0.4-review.md) | 正式採用・操作照会・安定ID・参照範囲 |

S17〜S20は設計上の評価と提案であり、採用済み実装や試験結果を示す資料ではない。現在の扱いは各ADR・OPEN-QUESTIONS.mdを優先する。

### サービス名

依頼文は「QrcaRouter」と表記しているが、参照した公開公式資料は「OrcaRouter」。本資料は後者に統一する。主催者が別サービスを指定している場合は接続前に照合し、この表記統一を同一サービスの契約上の保証とは扱わない。

## 事実と仮説の区別

- ユーザーが確定したのは案05採用・日数・人数・経験構成・協力先の不在。
- 提案したのはMVP範囲、技術構成、担当、状態モデル、試験、初期設定値。
- 検証前の仮説は料金、顧客層、件数、時間削減、原価、獲得費、維持率、実店舗導入条件。
- 公開仕様を確認したことは、APIへ実接続したこと、契約条件を承認したこと、セキュリティ監査を完了したことを意味しない。
- この成果物にアプリ実装・実測評価・営業・実従業員への連絡は含まれない。
