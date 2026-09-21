import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>Taskcal</h1>
      <p className="lede">
        飲食店の突発欠勤に対して代替スタッフの調整を進めるサービス。
        架空の1店舗・同時1案件・1職種・必要勤務枠1つを対象としたハッカソンMVPです。
      </p>

      <nav className="links">
        <Link href="/manager">店長画面</Link>
        <Link href="/staff">スタッフ画面（デモ役）</Link>
        <Link href="/api/health">起動状態 (JSON)</Link>
      </nav>

      <div className="notice">
        開発中です。画面は枠だけで、欠勤登録・打診・返信解釈・正式採用はまだ実装していません。
        表示している内容を、勤務が確定した証拠として扱わないでください。
      </div>

      <div className="notice">
        役の切替はローカルのデモ専用で、本人認証ではありません（ADR-008）。
        扱うデータは架空のものだけです。
      </div>
    </main>
  );
}
