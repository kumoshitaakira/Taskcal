import Link from "next/link";
import { getRuntimeStatus } from "@/application/runtime-status";
import { NotImplementedList, StatusPanel } from "../_components/status-panel";

// 起動状態を毎回確認する。
export const dynamic = "force-dynamic";

export default async function ManagerPage() {
  const status = await getRuntimeStatus();

  return (
    <main>
      <h1>店長画面</h1>
      <p className="lede">Day 1の枠のみ。欠勤登録から正式採用までの操作はDay 2以降に追加します。</p>
      <nav className="links">
        <Link href="/">トップ</Link>
        <Link href="/staff">スタッフ画面</Link>
      </nav>

      <h2>起動状態</h2>
      <StatusPanel status={status} />

      <h2>案件</h2>
      <div className="panel">
        <p className="lede" style={{ margin: 0 }}>
          進行中の案件はありません。欠勤登録はまだ実装していません。
        </p>
      </div>

      <div className="notice">
        表示する案件の状態は、案件・相手別対話・勤務表更新・メッセージ配送で分けて扱います （ADR-017
        / RFC-011 §5）。1つの状態にまとめて表示しません。
      </div>

      <NotImplementedList items={status.notImplemented} />
    </main>
  );
}
