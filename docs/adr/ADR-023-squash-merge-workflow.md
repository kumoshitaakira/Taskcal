# ADR-023：mainへのSquash mergeと履歴同期の運用

日付：2026-09-22／状態：採用
詳細：[AGENTS.md](../../AGENTS.md)／[AI開発ガイド](../AI-DEVELOPMENT.md)
関連：[ADR-021](ADR-021-two-person-delivery.md)／[RFC-012](../rfc/RFC-012-delivery-and-acceptance.md)
置換範囲：なし。開発ブランチの統合と`main`同期の手順を明文化する。

## 背景

このリポジトリでは、Pull Requestを`main`へ取り込む際にSquash mergeを使う。Squash
merge後の`main`には作業ブランチの個々のコミットが親子関係として残らないため、
Squash前の`main`上のコミットから派生したブランチと、現在の`origin/main`の間に
通常の共通祖先があるとは限らない。

この状態で履歴を確認せずに通常のmergeや`git rebase origin/main`を実行すると、
すでに`main`へ取り込まれた変更まで別の変更として再適用し、不要な大量の
コンフリクトや重複コミットを作る可能性がある。

## 決定

- `main`への変更はPull Request経由のSquash mergeで統合する。
- `main`へ同期する前に、`git fetch origin main`を実行し、現在の`origin/main`と作業ブランチの履歴および派生点を確認する。
- 作業ブランチがSquash前のコミットから派生している場合は、作業ブランチ上で最初に行った変更の直前など、確認済みの派生点を指定して次の形式でrebaseする。

  ```text
  git rebase --onto origin/main <branch-point> HEAD
  ```

- `git rebase origin/main`や履歴を確認しないmergeを、Squash merge後の同期方法として一律に使わない。
- rebase後にリモートの作業ブランチを更新するときは、別の更新を上書きしないよう`git push --force-with-lease`を使う。

## 帰結

変更済みの作業コミットだけを最新`main`の上へ移せるため、PRの差分とコンフリクトを小さく保ちやすい。一方、rebase前に派生点を誤ると変更を取りこぼす可能性があるため、履歴確認とrebase後のテストを必須とする。

Squash mergeの採用はGitの履歴運用に関するものであり、Taskcalのプロダクト挙動、ドメイン保証、受入条件を変更しない。

## 検証

新しい作業ブランチを最新`origin/main`から作成し、本ADR、エージェント指示、開発ガイド、設計記録の変更履歴から相互に参照できることを確認する。コード変更はないため、アプリケーションのbuildや受入テストは対象外とする。
