import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getManagerView } from "@/application/case-view";
import { getModelUsageView } from "@/application/model-usage-view";
import { getRuntimeStatus } from "@/application/runtime-status";
import { CasePanel } from "../_components/case-panel";
import { Notice } from "../_components/notice";
import { NotImplementedList, StatusPanel } from "../_components/status-panel";
import { UsagePanel } from "../_components/usage-panel";
import {
  adoptPlanAction,
  createAbsenceCaseAction,
  startOutreachAction,
  stopCaseAction,
} from "./actions";

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
  // 実測・推定・取得不能を分けて出す（RFC-004 §8）。案件が無ければ読まない。
  const usage = view.activeCase ? await getModelUsageView(view.activeCase.caseId) : undefined;

  // 操作IDは描画時に作る。二重クリック・再読込・戻る操作が同じキーになり、
  // operation_result の照合で REPLAY になる（ADR-006 / D07）。
  const createOperationId = `case:${randomUUID()}`;
  const outreachOperationId = view.activeCase
    ? `outreach:${view.activeCase.caseId}`
    : `outreach:${randomUUID()}`;
  // 正式採用のキーは**描画ごと**に作る。同じ描画内の二重クリックだけが同じキーで、
  // 再読込・戻る操作は別の操作になる（打診の `outreach:{caseId}` とは違う）。
  // 内容から決めてしまうと、未実装で一度断った結果を実装が入った後も返し続けるため。
  // 進行中の更新は作り直さず `findOpenByCase` で再開する（`adopt-plan.ts`）。
  const adoptOperationId = `adopt:${view.activeCase?.caseId ?? "none"}:${randomUUID()}`;
  // 停止も描画ごとのキー。二重クリックは同じ操作になり、停止済みの案件への再送信は
  // 「すでに停止しています」で断られる（`stop-case.ts`）。
  const stopOperationId = `stop:${view.activeCase?.caseId ?? "none"}:${randomUUID()}`;
  // 進行中の更新は作り直さず再開する（RFC-010 §7）。
  const resuming =
    view.activeCase?.state === "PREPARING" || view.activeCase?.state === "RECONCILE_REQUIRED";
  const stopped = Boolean(view.activeCase?.stopCause);
  // 停止できるのは自動調整が続いている間だけ。確定済みの取消は別の操作（D10）。
  const canStop =
    view.activeCase?.state === "COORDINATING" || view.activeCase?.state === "PREPARING";
  // **停止済みでも再開は出す。**
  // 採用の操作が進行中のまま落ちると、worker は結果が確定するまで触らないので
  // （`recover-case.ts`）、案件が準備中のまま誰にも動かせなくなる。再開は
  // 採用をやり直す操作ではない——照会して成否を確かめ、停止済みなら手順5が
  // `CASE_STOPPED` で断って `resolvePreparingStop` の行き先へ確定させる（D10）。
  // **新しく採用を始める方は、停止済みでは出さない。**
  const canAdopt = Boolean(
    view.activeCase &&
    (resuming ||
      (!stopped &&
        view.activeCase.state === "COORDINATING" &&
        view.activeCase.outreaches.some((outreach) => outreach.selectable))),
  );

  return (
    <main>
      <h1>店長画面</h1>
      <p className="lede">
        固定の架空CSVを取り込んだ勤務表から欠勤を登録できます。個別打診、返信・承諾、選定、正式採用、読戻し、模擬通知の経路を接続しています。打診候補は名簿条件で列挙し、固定デモ日の正式採用直前に可能時間・重複・月次上限を再検査します。停止・期限・通知復旧の状態も画面で確認できます。
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

      {canAdopt && view.activeCase ? (
        <form action={adoptPlanAction} className="panel">
          <input type="hidden" name="operationId" value={adoptOperationId} />
          <input type="hidden" name="caseId" value={view.activeCase.caseId} />
          <p className="lede" style={{ margin: 0 }}>
            {resuming && stopped
              ? // 停止済みの再開は、採用のやり直しではない。成否を確かめて行き先を決める。
                "停止した案件に、結果の分からない勤務表更新が残っています。作り直さず、結果を照会して成否を確かめます。停止済みなので正式採用は行いません（D10）。"
              : resuming
                ? // 再実行しない。進行中の更新は作り直さず、照会して照合してから進む（A03）。
                  "進行中の勤務表更新があります。作り直さず、結果を照会して照合してから続きを進めます。"
                : "選定可の承諾から計画を固定し、作業用CSVの生成・読戻しを経て正式採用します。採用の直前に案件版・停止・期限・承諾・未処理返信・月内入力の完全性をもう一度検査します（D08）。"}{" "}
            <strong>
              固定デモCSVでのみ実行します。結果不明や読戻し不一致は要対応として止めます。
            </strong>
          </p>
          <button type="submit">
            {resuming && stopped
              ? "停止の結果を確定させる"
              : resuming
                ? "正式採用の続きを進める"
                : "正式採用へ進む"}
          </button>
        </form>
      ) : null}

      {view.activeCase && !view.activeCase.stopCause && canStop ? (
        <form action={stopCaseAction} className="panel">
          <input type="hidden" name="operationId" value={stopOperationId} />
          <input type="hidden" name="caseId" value={view.activeCase.caseId} />
          <p className="lede" style={{ margin: 0 }}>
            調整を止めます。以後は新規の打診も正式採用も行いません（D10）。送信済みの打診には募集終了を通知し、承諾は失効させます（Q07）。{" "}
            <strong>停止は取り消せません。</strong>
            {view.activeCase.state === "PREPARING"
              ? " 正式採用の準備中です。停止を記録したうえで、並行する更新の結果を確認してから行き先を決めます（Q13）。"
              : ""}
          </p>
          <button type="submit">調整を停止する</button>
        </form>
      ) : null}

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

      {usage ? (
        <>
          <h2>モデル呼出しと費用</h2>
          <UsagePanel usage={usage} />
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
