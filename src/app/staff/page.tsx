import Link from "next/link";

export default function StaffPage() {
  return (
    <main>
      <h1>スタッフ画面（デモ役）</h1>
      <p className="lede">
        架空スタッフとして打診を確認し、返信するための画面。Day 1は枠のみです。
      </p>
      <nav className="links">
        <Link href="/">トップ</Link>
        <Link href="/manager">店長画面</Link>
      </nav>

      <h2>受信箱</h2>
      <div className="panel">
        <p className="lede" style={{ margin: 0 }}>
          打診はありません。模擬メッセージ受信箱はまだ実装していません。
        </p>
      </div>

      <div className="notice">
        役の切替はローカルのデモ専用であり、本人認証ではありません（ADR-008 / RFC-011 §6）。
        本文で名乗った名前を本人の証拠として扱いません。
      </div>

      <div className="notice">
        欠勤理由や辞退理由は尋ねません（ADR-008）。過去の辞退を候補順位の減点に使いません。
      </div>
    </main>
  );
}
