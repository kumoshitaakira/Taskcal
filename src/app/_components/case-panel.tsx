/**
 * 案件の表示。
 *
 * ADR-017 / ADR-022：案件・相手別対話・勤務表更新・メッセージ配送・採用事実を
 * **別々のタグ**で出す。1つにまとめない。まとめると、採用済みなのに通知が失敗した
 * 案件を「未確定」と表示しかねない。
 *
 * 色の割当：
 *   - 照合が必要・結果不明・引き継ぎ済みは `tag-warn`。**`tag-bad` にしない。**
 *     未確定と断定しないため（ADR-022）。
 *   - 未送信（REFUSED）は「失敗」と書かない。配送失敗と区別する（RFC-011 §6）。
 */

import type { AdoptionFact, CaseState } from "@/contracts/case-state";
import type { CommitmentBlockReason, CommitmentStatus } from "@/contracts/commitment";
import type { DeliveryState, OutreachState } from "@/contracts/outreach-state";
import type { ScheduleUpdateState } from "@/contracts/schedule-update";
import type { CaseView } from "@/application/case-view";

const CASE_LABEL: Record<CaseState, string> = {
  COORDINATING: "調整中",
  PREPARING: "確定準備",
  COMMITTED: "確定済み",
  RECONCILE_REQUIRED: "照合が必要",
  REPORTING: "通知処理中",
  ATTENTION: "要対応",
  COMPLETED: "完了",
  HANDED_OFF: "人へ引き継ぎ",
  CANCELLED: "停止",
};

const CASE_CLASS: Record<CaseState, string> = {
  COORDINATING: "tag",
  PREPARING: "tag",
  COMMITTED: "tag tag-ok",
  // 断定しない。bad にしない。
  RECONCILE_REQUIRED: "tag tag-warn",
  REPORTING: "tag",
  ATTENTION: "tag tag-bad",
  COMPLETED: "tag tag-ok",
  HANDED_OFF: "tag tag-warn",
  CANCELLED: "tag tag-warn",
};

const ADOPTION_LABEL: Record<AdoptionFact, string> = {
  NOT_ADOPTED: "未採用",
  ADOPTED: "採用済み",
  UNKNOWN: "成否不明",
};

const ADOPTION_CLASS: Record<AdoptionFact, string> = {
  NOT_ADOPTED: "tag",
  ADOPTED: "tag tag-ok",
  UNKNOWN: "tag tag-warn",
};

const OUTREACH_LABEL: Record<OutreachState, string> = {
  PENDING_SEND: "送信待ち",
  SENT: "送信済み",
  AWAITING_REPLY: "返信待ち",
  CLARIFYING: "追加確認中",
  ANSWERED: "回答済み",
  EXPIRED: "失効",
  CLOSED: "終了",
};

const OUTREACH_CLASS: Record<OutreachState, string> = {
  PENDING_SEND: "tag tag-warn",
  SENT: "tag",
  AWAITING_REPLY: "tag",
  CLARIFYING: "tag tag-warn",
  ANSWERED: "tag tag-ok",
  EXPIRED: "tag tag-warn",
  CLOSED: "tag",
};

const DELIVERY_LABEL: Record<DeliveryState, string> = {
  QUEUED: "送信前",
  ACCEPTED: "受付済み",
  FAILED: "配送失敗",
  UNKNOWN: "結果不明",
};

const DELIVERY_CLASS: Record<DeliveryState, string> = {
  QUEUED: "tag",
  ACCEPTED: "tag tag-ok",
  FAILED: "tag tag-bad",
  // 失敗と断定しない。
  UNKNOWN: "tag tag-warn",
};

const REFUSAL_LABEL: Record<string, string> = {
  ENDPOINT_CHANGED: "未送信（宛先が変わった）",
  NOT_PERMITTED: "未送信（連絡許可なし）",
  CONFLICT: "未送信（内容不一致）",
};

const COMMITMENT_LABEL: Record<CommitmentStatus, string> = {
  ACTIVE: "承諾あり",
  HELD: "保留",
  SUPERSEDED: "置き換え済み",
  WITHDRAWN: "撤回",
  EXPIRED: "失効",
};

const COMMITMENT_CLASS: Record<CommitmentStatus, string> = {
  ACTIVE: "tag tag-ok",
  HELD: "tag tag-warn",
  SUPERSEDED: "tag",
  WITHDRAWN: "tag",
  EXPIRED: "tag tag-warn",
};

const UPDATE_LABEL: Record<ScheduleUpdateState, string> = {
  PREPARING: "作成中",
  PREPARED: "検査済み（未採用）",
  ADOPTED: "正式採用",
  RECONCILE_REQUIRED: "照合が必要",
  REJECTED: "不採用",
};

const UPDATE_CLASS: Record<ScheduleUpdateState, string> = {
  PREPARING: "tag",
  PREPARED: "tag tag-warn",
  ADOPTED: "tag tag-ok",
  RECONCILE_REQUIRED: "tag tag-warn",
  REJECTED: "tag",
};

const HANDOFF_LABEL: Record<string, string> = {
  CANDIDATES_EXHAUSTED: "候補が尽きた",
  DEADLINE_REACHED: "期限に達した",
  LIMIT_REACHED: "予算・回数の上限に達した",
  RECONCILE_STALLED: "採用結果の照合が継続不能",
  REPORTING_FAILED: "読戻しまたは通知が復旧しない",
};

const STOP_LABEL: Record<string, string> = {
  MANAGER_STOP: "店長が停止した",
  DEADLINE: "期限に達した",
  LIMIT: "上限に達した",
  CANDIDATES_EXHAUSTED: "候補が尽きた",
};

const KIND_LABEL: Record<string, string> = {
  INITIAL_OFFER: "初回打診",
  CLARIFICATION: "追加確認",
  CONFIRMATION: "確定通知",
  NOT_SELECTED: "非選定通知",
  CASE_CLOSED: "募集終了通知",
};

const OUTBOX_STATUS_LABEL: Record<string, string> = {
  PENDING: "送信待ち",
  SENT: "送信済み",
  FAILED: "配送失敗",
  UNKNOWN: "結果不明",
  REFUSED: "未送信",
};

/** 対応表に無い値を握り潰さない。生の値を出して、訳し忘れに気付けるようにする。 */
function label(map: Record<string, string>, value: string): string {
  return map[value] ?? `未対応の値: ${value}`;
}

export function CaseStateTag({ state }: { state: CaseState }) {
  return <span className={CASE_CLASS[state]}>{CASE_LABEL[state]}</span>;
}

export function AdoptionFactTag({ fact }: { fact: AdoptionFact }) {
  return <span className={ADOPTION_CLASS[fact]}>{ADOPTION_LABEL[fact]}</span>;
}

export function OutreachTag({ state }: { state: OutreachState }) {
  return <span className={OUTREACH_CLASS[state]}>{OUTREACH_LABEL[state]}</span>;
}

export function DeliveryTag({ state, refusal }: { state?: DeliveryState; refusal?: string }) {
  // 未送信は配送状態を持たない。「失敗」と書かない。
  if (refusal) return <span className="tag tag-warn">{REFUSAL_LABEL[refusal] ?? "未送信"}</span>;
  if (!state) return <span className="tag">未送信</span>;
  return <span className={DELIVERY_CLASS[state]}>{DELIVERY_LABEL[state]}</span>;
}

const BLOCK_LABEL: Record<CommitmentBlockReason, string> = {
  NOT_ACTIVE: "選定不可",
  SUPERSEDED: "選定不可（置き換え済み）",
  UNPROCESSED_REPLY: "選定不可（未処理の返信）",
  DEADLINE_PASSED: "選定不可（期限切れ）",
};

/**
 * 承諾の状態と、選定へ出せるかを**別々に**出す。
 * `ACTIVE` でも未処理の返信があれば選定できない（D04 / A05）。status だけを見せると、
 * 選定できない承諾を選定可と読ませてしまう。
 */
export function CommitmentTag({
  status,
  selectable,
  blockReason,
}: {
  status?: CommitmentStatus;
  selectable?: boolean;
  blockReason?: CommitmentBlockReason;
}) {
  if (!status) return <span className="tag">承諾なし</span>;
  return (
    <span className="tags">
      <span className={COMMITMENT_CLASS[status]}>{COMMITMENT_LABEL[status]}</span>
      {selectable ? (
        <span className="tag tag-ok">選定可</span>
      ) : blockReason ? (
        <span className="tag tag-warn">{BLOCK_LABEL[blockReason]}</span>
      ) : null}
    </span>
  );
}

export function ScheduleUpdateTag({ state }: { state: ScheduleUpdateState }) {
  return <span className={UPDATE_CLASS[state]}>{UPDATE_LABEL[state]}</span>;
}

/** 営業日を併記する欄で使う。日付は呼び出し側が出す。 */
function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** 期限は営業日と別の日になり得るので、日付を落とさない。 */
function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function CasePanel({ view, timeZone }: { view: CaseView; timeZone: string }) {
  return (
    <>
      <div className="panel">
        <dl>
          <div className="row">
            <dt>案件</dt>
            <dd>
              <span className="tags">
                <CaseStateTag state={view.state} />
              </span>{" "}
              版 {view.version}
              {view.handoffReason
                ? `／引き継ぎ理由：${label(HANDOFF_LABEL, view.handoffReason)}`
                : ""}
              {view.stopCause ? `／停止：${label(STOP_LABEL, view.stopCause)}` : ""}
            </dd>
          </div>
          <div className="row">
            <dt>採用事実</dt>
            <dd>
              <span className="tags">
                <AdoptionFactTag fact={view.adoptionFact} />
              </span>{" "}
              案件の状態からは判断しません（ADR-022）
            </dd>
          </div>
          <div className="row">
            <dt>必要枠</dt>
            <dd>
              {view.businessDate} {formatTime(view.requiredStartAt, timeZone)}〜
              {formatTime(view.requiredEndAt, timeZone)}（欠勤：{view.absentStaffName}）
            </dd>
          </div>
          <div className="row">
            <dt>回答期限</dt>
            <dd>{formatDateTime(view.deadlineAt, timeZone)}</dd>
          </div>
        </dl>
      </div>

      <h2>勤務表更新</h2>
      <div className="panel">
        {view.scheduleUpdates.length === 0 ? (
          <p className="lede" style={{ margin: 0 }}>
            ありません。「正式採用へ進む」で選定が成立すると、CSV管理版の作業用成果物がここに現れます。
          </p>
        ) : (
          <dl>
            {view.scheduleUpdates.map((update) => (
              <div className="row" key={update.scheduleUpdateId}>
                <dt>
                  <ScheduleUpdateTag state={update.state} />
                </dt>
                <dd>
                  操作ID {update.operationId}
                  {update.artifactRef
                    ? `／成果物 ${update.artifactRef}（${
                        update.state === "ADOPTED" ? "正式版" : "未採用"
                      }）`
                    : ""}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <h2>打診</h2>
      {view.outreaches.length === 0 ? (
        <div className="panel">
          <p className="lede" style={{ margin: 0 }}>
            まだ打診していません。
          </p>
        </div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>スタッフ</th>
              <th>打診</th>
              <th>配送</th>
              <th>承諾</th>
              <th>受信順</th>
            </tr>
          </thead>
          <tbody>
            {view.outreaches.map((outreach) => (
              <tr key={outreach.outreachId}>
                <td>{outreach.staffName}</td>
                <td>
                  <OutreachTag state={outreach.state} />
                </td>
                <td>
                  <DeliveryTag state={outreach.delivery} refusal={outreach.refusal} />
                </td>
                <td>
                  <CommitmentTag
                    status={outreach.commitmentStatus}
                    selectable={outreach.selectable}
                    blockReason={outreach.blockReason}
                  />
                </td>
                <td>
                  {outreach.lastReceivedSeq ?? "—"}
                  {outreach.lastReceivedSeq && outreach.lastReceivedSeq > outreach.appliedSeq
                    ? "（未処理）"
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>通知待ち</h2>
      <div className="panel">
        {view.outbox.length === 0 ? (
          <p className="lede" style={{ margin: 0 }}>
            ありません。
          </p>
        ) : (
          <dl>
            {view.outbox.map((row) => (
              <div className="row" key={`${row.kind}:${row.status}`}>
                <dt>{label(KIND_LABEL, row.kind)}</dt>
                <dd>
                  {label(OUTBOX_STATUS_LABEL, row.status)} × {row.count}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {view.unmatchedInbound > 0 ? (
        <div className="notice">
          打診の宛先と一致しない受信が {view.unmatchedInbound} 件あります。承諾には使いませんが、
          記録は残しています（A15）。
        </div>
      ) : null}
    </>
  );
}
