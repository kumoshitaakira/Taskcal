# ADR-025：停止が成立した案件に、照合後の終端を与える

日付：2026-09-22／状態：ユーザー承認待ち。Day 3の実装で判明
詳細：[ADR-022](ADR-022-handoff-and-outcome-retention.md)、[RFC-011](../rfc/RFC-011-outreach-and-state.md)
更新範囲：[RFC-011](../rfc/RFC-011-outreach-and-state.md) §5の状態図。ADR-022 の方針は変えず、その適用範囲を1状態ぶん広げる。

## 背景

ADR-022 は `Preparing → HandedOff`（未採用を確認できた停止）を追加した。Day 3で停止を実装したところ、
**停止が成立したまま `ReconcileRequired` に入る経路がある**ことが分かった。

- `Preparing` 中に停止し、採用の成否が不明なら `resolvePreparingStop` が `ReconcileRequired` を返す
- その後の照合で「未採用」と確認できても、`ReconcileRequired` の出口は
  `Committed` / `Coordinating` / `Attention` しかない

`Coordinating` へ戻すと、**停止印が付いたままの案件が「調整中」として復帰する**。停止理由に応じた終端
（`Cancelled` / `HandedOff`）も引き継ぎ記録も作られず、案件は終端に達しない。D10（停止成立後に新規打診・
正式採用をしない）は他の検査で守られるが、A18の「新規打診・正式採用を止め、既確定の事実を保持して
引き継ぐ」を状態で表現できない。

`Attention` へ逃がす案も考えたが、こちらは**未採用と確認できている**。成否不明として人の対応を記録する
`Attention` の意味と合わない。

## 決定

`ReconcileRequired → Cancelled` と `ReconcileRequired → HandedOff` を追加する。

**条件は ADR-022 の `Preparing → HandedOff` と同じ**：停止が成立しており（`stoppedAt` がある）、かつ
未採用を確認できた場合に限る。判断は `resolvePreparingStop` を通す。同じ判断を二つの状態から使うため、
この関数は「`Preparing` 専用」ではなく「**停止が成立した案件の行き先**」を決めるものとして読む。

停止が成立していない `ReconcileRequired` の扱いは変えない。未採用と確認できたら `Coordinating` へ戻し、
照合が継続不能なら `Attention` へ回す（ADR-022 / Q11）。

## 選択肢

`Attention` へ逃がす案は、状態図を変えずに済む。しかし未採用と確認できた案件を「成否不明」として記録する
ことになり、`Attention` の意味が薄まる。人の対応も不要なのに待たせる。

`Coordinating` を許したまま、停止済みなら自動調整を再開しない検査を各所へ足す案もある。すでに
`start-outreach` と `adopt-plan` が `stoppedAt` を見ているので動きはするが、画面には「調整中」と出る。
状態から業務の実態を読めなくなるため採らない。

`Preparing` から `ReconcileRequired` へ入れない案（照合が済むまで `Preparing` に留める）は、照会が恒久的に
不能な場合に永久非終端を作る。ADR-022 が解こうとした問題に戻る。

## 帰結

`ReconcileRequired` の出口が5つになる。どれを使うかは照合結果と停止印の両方で決まるため、
`isAllowedCaseTransition` だけで動かしてはいけない状態がもう一つ増える。実装は
`resolvePreparingStop` を必ず通すこと。

停止した案件は、採用済みなら `Committed` 以降、未採用なら停止理由に応じた終端、成否不明なら
`ReconcileRequired` に留まる。**成否不明のまま終端へ落とさない**というADR-022の方針は維持する。

## 検証

A18（停止、予算・回数・期限到達）、A03（正式採用直後の応答喪失）。
`tests/integration/recover.test.ts` で、停止した案件が `Coordinating` へ戻らないことを確かめる。
