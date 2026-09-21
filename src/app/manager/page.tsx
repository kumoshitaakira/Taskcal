import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getManagerView } from "@/application/case-view";
import { getRuntimeStatus } from "@/application/runtime-status";
import { CasePanel } from "../_components/case-panel";
import { Notice } from "../_components/notice";
import { NotImplementedList, StatusPanel } from "../_components/status-panel";
import { createAbsenceCaseAction, startOutreachAction } from "./actions";

// 起動状態と案件を毎回確認する。
export const dynamic = "force-dynamic";

/** `datetime-local` の初期値。店舗timezoneで表示する。 */
function localInputValue(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  return parts.replace(" ", "T");
}

function formatOption(
  option: {
    businessDate: string;
    startAt: string;
    endAt: string;
    staffName: string;
  },
  timeZone: string,
): string {
  const time = (iso: string) =>
    new Intl.DateTimeFormat("ja-JP", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  return `${option.businessDate} ${time(option.startAt)}〜${time(option.endAt)}　${option.staffName}`;
}

/** 店舗timezoneのUTCオフセット（`+09:00`）。`datetime-local` の解釈に使う。 */
function offsetOf(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName");
  // "GMT+09:00" → "+09:00"。UTCちょうどのときは "GMT" になる。
  const name = parts?.value ?? "GMT";
  return name === "GMT" ? "+00:00" : name.replace("GMT", "");
}

export default async function ManagerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const noticeCode = typeof params.n === "string" ? params.n : undefined;
  const noticeCount = typeof params.c === "string" ? params.c : undefined;
  const now = new Date().toISOString();
  const [status, view] = await Promise.all([getRuntimeStatus(), getManagerView(now)]);

  // 操作IDは描画時に作る。二重クリック・再読込・戻る操作が同じキーになり、
  // operation_result の照合で REPLAY になる（ADR-006 / D07）。
  const createOperationId = `case:${randomUUID()}`;
  const outreachOperationId = view.activeCase
    ? `outreach:${view.activeCase.caseId}`
    : `outreach:${randomUUID()}`;

  return (
    <main>
      <h1>店長画面</h1>
      <p className="lede">
        欠勤の登録、名簿上の同職種への同時打診、返信の受信までが動きます。適格性（可能時間・月次上限・勤務の重複）は未検査で、返信の解釈・正式採用も未実装です。
      </p>
      <nav className="links">
        <Link href="/">トップ</Link>
        <Link href="/staff">スタッフ画面</Link>
      </nav>

      <Notice code={noticeCode} count={noticeCount} />

      <h2>起動状態</h2>
      <StatusPanel status={status} />

      {!view.storeId ? (
        <div className="notice">
          店舗データがありません。<code>npm run seed:dev</code> で架空データを入れてください。
        </div>
      ) : null}

      <h2>案件</h2>
      {view.activeCase ? (
        <CasePanel view={view.activeCase} timeZone={view.timeZone} />
      ) : (
        <div className="panel">
          <p className="lede" style={{ margin: 0 }}>
            進行中の案件はありません。
          </p>
        </div>
      )}

      {view.activeCase && view.activeCase.outreaches.length === 0 ? (
        <form action={startOutreachAction} className="panel">
          <input type="hidden" name="operationId" value={outreachOperationId} />
          <input type="hidden" name="caseId" value={view.activeCase.caseId} />
          <p className="lede" style={{ margin: 0 }}>
            名簿上の同職種の全員（欠勤者本人を除く）へ個別に打診します。適格性は未検査です。送信はworkerが行います。
          </p>
          <button type="submit">打診を開始する</button>
        </form>
      ) : null}

      {!view.activeCase && view.storeId && view.connectionId ? (
        <>
          <h2>欠勤を登録する</h2>
          <form action={createAbsenceCaseAction} className="panel">
            <input type="hidden" name="operationId" value={createOperationId} />
            <input type="hidden" name="storeId" value={view.storeId} />
            <input type="hidden" name="connectionId" value={view.connectionId} />
            {/* `datetime-local` は timezone を持たない。店舗timezoneのoffsetを添える。 */}
            <input
              type="hidden"
              name="timeZoneOffset"
              value={offsetOf(view.timeZone, new Date(now))}
            />
            <div className="row">
              <label htmlFor="shiftAssignmentId">欠勤する勤務</label>
              <select id="shiftAssignmentId" name="shiftAssignmentId" required>
                {view.shiftOptions.map((option) => (
                  <option key={option.shiftAssignmentId} value={option.shiftAssignmentId}>
                    {formatOption(option, view.timeZone)}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <label htmlFor="deadlineAt">回答期限</label>
              <input
                id="deadlineAt"
                name="deadlineAt"
                type="datetime-local"
                required
                defaultValue={
                  view.shiftOptions[0]
                    ? localInputValue(view.shiftOptions[0].startAt, view.timeZone)
                    : undefined
                }
              />
            </div>
            <button type="submit" disabled={view.shiftOptions.length === 0}>
              欠勤を登録する
            </button>
            {view.shiftOptions.length === 0 ? (
              <p className="lede">
                予定済みの勤務がありません。<code>npm run seed:dev</code> を実行してください。
              </p>
            ) : null}
          </form>
          <div className="notice">
            Q04により欠勤は元勤務の全時間です。部分欠勤・日跨ぎは範囲外として拒否します。
          </div>
        </>
      ) : null}

      <div className="notice">
        案件の状態は、案件・相手別対話・勤務表更新・メッセージ配送で分けて扱います（ADR-017 /
        RFC-011 §5）。1つの状態にまとめて表示しません。採用の有無は案件状態ではなく採用事実を見ます
        （ADR-022）。
      </div>

      <NotImplementedList items={status.notImplemented} />
    </main>
  );
}
