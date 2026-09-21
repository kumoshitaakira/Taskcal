/**
 * 返信の解釈と承諾の生成（RFC-011 §3・§4、Q09、ADR-004、ADR-014）。
 *
 * モデルがするのは返信の解釈と次行動の提案だけ。**本人確認・適格性・時間・承諾の
 * 成立・上限・状態遷移は、ここの決定的なコードが検査する。**
 *
 * A12 の要は「適用」の段。`last_applied_seq` より小さい受信順の解釈は、遅れて
 * 返っても適用しない。時刻ではなく受信順で新旧を決める。古い結果も**保存はする**
 * ——なぜ承諾にしなかったかを後から説明できなくなるため。
 *
 * 「承諾として採用しない」と「返信を無視する」は別（Q09）。承諾にできない返信も、
 * 辞退・撤回・保留として状態へ反映する。
 */

import "server-only";
import { assertOutsideTransaction, withTransaction } from "../adapters/db/transaction";
import { MAX_ADDITIONAL_SHIFT_MINUTES, TIME_GRANULARITY_MINUTES } from "../config/mvp-policy";
import type { ModelGateway } from "../adapters/orca/model-gateway";
import { ERROR_CODES, TaskcalError, type ErrorCode } from "../contracts/errors";
import { computeRequestHash } from "../contracts/operation";
import {
  MODEL_OUTPUT_SCHEMA_VERSION,
  type ModelReplyOutput,
  type ReplyIntent,
} from "../contracts/model-output";
import type {
  AbsenceCaseRepository,
  Clock,
  CommitmentRepository,
  IdGenerator,
  InboundEventRepository,
  InterpretationApplication,
  OutboxRepository,
  OutreachRepository,
  ReplyInterpretationRepository,
} from "../contracts/repository";
import { INTERPRETATION_APPLICATION, type TxHandle } from "../contracts/repository";
import { TERMINAL_OUTREACH_STATES } from "../contracts/outreach-state";
import type { SendPayloadForHash } from "../contracts/messaging-gateway";
import { buildClarificationBody } from "./offer-message";

/** プロンプトと抽出規則の版。モデル出力のschema版と併せて記録する（RFC-004）。 */
export const PROMPT_VERSION = "reply-interpretation/0.1.0-draft";

export interface InterpretReplyInput {
  readonly inboundEventId: string;
  /** 同じ受信への再試行。requestId に含めるので、再試行は別の呼出しになる。 */
  readonly attempt?: number;
}

export type InterpretReplyResult =
  | {
      readonly ok: true;
      readonly applied: InterpretationApplication;
      readonly intent: ReplyIntent;
      readonly commitmentId?: string;
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly detail: string };

export interface InterpretReplyDeps {
  readonly model: ModelGateway;
  readonly cases: AbsenceCaseRepository;
  readonly outreaches: OutreachRepository;
  readonly inbound: InboundEventRepository;
  readonly interpretations: ReplyInterpretationRepository;
  readonly commitments: CommitmentRepository;
  readonly outbox: OutboxRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

function fail(code: ErrorCode, detail: string): InterpretReplyResult {
  return { ok: false, code, detail };
}

/** 決定的検査の結果。モデルの自己申告は使わない。 */
/** 承諾にできない理由。追加確認へ回すものと、範囲外として明示的に断るものを分ける。 */
export const CHECK_REJECTION = {
  /** 条件が一意に定まらない。追加確認へ回す（Q09）。 */
  AMBIGUOUS: "AMBIGUOUS",
  /** Q03・Q05・Q10：**範囲外**。丸めず明示的に断る。追加確認で聞き直さない。 */
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  /** 期限を過ぎている。確定へ使わない（RFC-011 §4）。 */
  DEADLINE: "DEADLINE",
  /** 承諾を意図した返信ではない。 */
  NOT_AN_ACCEPT: "NOT_AN_ACCEPT",
} as const;

export type CheckRejection = (typeof CHECK_REJECTION)[keyof typeof CHECK_REJECTION];

type CheckResult =
  | { ok: true; startAt: string; endAt: string }
  | { ok: false; reason: CheckRejection; detail: string };

/**
 * 承諾にできる条件かどうか。**モデルに委ねない。**
 *
 * Q03：分断した可能時間は範囲外。複数区間を1つへ丸めない。
 * Q05：日跨ぎは範囲外。
 * Q10：15分刻み、最長4時間。
 * D03：提示した区間・職種・期限の中に収まること。
 */
function checkOfferedRange(input: {
  output: ModelReplyOutput;
  offeredStartAt: string;
  offeredEndAt: string;
  deadlineAt: string;
  now: string;
}): CheckResult {
  const ranges = input.output.interpretation.offeredRanges;
  if (ranges.length !== 1) {
    // Q03：分断した可能時間は範囲外。中間の勤務済み時間を埋めて1区間へ戻さない。
    return { ok: false, reason: CHECK_REJECTION.OUT_OF_SCOPE, detail: "SPLIT" };
  }
  if (input.output.interpretation.unresolvedConditions.length > 0) {
    return { ok: false, reason: CHECK_REJECTION.AMBIGUOUS, detail: "UNRESOLVED" };
  }
  if (Date.parse(input.now) >= Date.parse(input.deadlineAt)) {
    return { ok: false, reason: CHECK_REJECTION.DEADLINE, detail: "DEADLINE" };
  }

  const { startAt, endAt } = ranges[0];
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
    return { ok: false, reason: CHECK_REJECTION.AMBIGUOUS, detail: "RANGE" };
  }
  if (startAt.slice(0, 10) !== endAt.slice(0, 10)) {
    // Q05：日跨ぎは範囲外。黙って同一営業日へ丸めない。
    return { ok: false, reason: CHECK_REJECTION.OUT_OF_SCOPE, detail: "OVERNIGHT" };
  }
  const minutes = (end - start) / 60_000;
  if (minutes % TIME_GRANULARITY_MINUTES !== 0) {
    return { ok: false, reason: CHECK_REJECTION.OUT_OF_SCOPE, detail: "GRANULARITY" };
  }
  if (minutes > MAX_ADDITIONAL_SHIFT_MINUTES) {
    return { ok: false, reason: CHECK_REJECTION.OUT_OF_SCOPE, detail: "TOO_LONG" };
  }
  if (start < Date.parse(input.offeredStartAt) || end > Date.parse(input.offeredEndAt)) {
    return { ok: false, reason: CHECK_REJECTION.OUT_OF_SCOPE, detail: "OUTSIDE_OFFER" };
  }
  return { ok: true, startAt, endAt };
}

/**
 * 終端でない最新の承諾。
 *
 * **`ACTIVE` だけを見ない。** 曖昧な返信で `HELD` になった承諾へ、その後の辞退・撤回・
 * 訂正が届く。`ACTIVE` だけを見ると旧版が閉じられないまま新版ができ、撤回が反映されない
 * （RFC-011 §4）。
 */
async function latestOpenCommitment(
  deps: Pick<InterpretReplyDeps, "commitments">,
  tx: TxHandle,
  caseId: string,
  staffId: string,
) {
  const all = await deps.commitments.listByCase(tx, caseId);
  return all
    .filter((c) => c.staffId === staffId && (c.status === "ACTIVE" || c.status === "HELD"))
    .at(-1);
}

export function interpretReply(deps: InterpretReplyDeps) {
  return async function run(input: InterpretReplyInput): Promise<InterpretReplyResult> {
    const attempt = input.attempt ?? 1;

    // 1. スナップショットを取引の外で読む。ここから呼出しまでに前提が変われば、
    //    適用の段で案件版を照合して弾く（D08）。
    const snapshot = await withTransaction(async (tx) => {
      const stored = await deps.inbound.findById(tx, input.inboundEventId);
      if (stored === "NOT_FOUND") return undefined;
      // 受信時に確定した打診をそのまま使う。宛先から逆引きしない——同じ宛先が
      // 複数の案件に現れると別案件の打診を引き当てるし、受信後に宛先の版が
      // 上がると引けなくなって前へ進めなくなる（D03、A15）。
      const message = await tx.query<{ message_id: string; outreach_id: string | null }>(
        "select message_id, outreach_id from inbound_event where inbound_event_id = $1",
        [input.inboundEventId],
      );
      const outreachId = message.rows[0]?.outreach_id;
      if (!outreachId) return undefined;
      const outreach = await deps.outreaches.findById(tx, outreachId);
      if (outreach === "NOT_FOUND" || outreach.caseId !== stored.caseId) return undefined;
      const caseSnapshot = await deps.cases.findById(tx, stored.caseId);
      if (caseSnapshot === "NOT_FOUND") return undefined;
      const store = await tx.query<{ name: string; timezone: string }>(
        "select name, timezone from store where store_id = $1",
        [caseSnapshot.storeId],
      );
      return {
        stored,
        outreach,
        caseSnapshot,
        // 現在の承諾。モデルへ渡す文脈にだけ使う。適用時は取引の中で読み直す。
        current: await latestOpenCommitment(deps, tx, stored.caseId, outreach.staffId),
        // 正式採用が済んでいるか。確定前後で返信の扱いが変わる（Q09）。
        afterCommit: caseSnapshot.adoptionFact === "ADOPTED",
        messageId: message.rows[0]?.message_id,
        store: store.rows[0],
      };
    });

    if (!snapshot || !snapshot.messageId) {
      return fail(ERROR_CODES.INVALID_INPUT, "対象の受信が見つかりません。");
    }
    const { stored, outreach, caseSnapshot, current, afterCommit, messageId, store } = snapshot;
    if (!store) {
      return fail(ERROR_CODES.INVALID_INPUT, "店舗が見つかりません。");
    }
    if (!stored.event.body) {
      return fail(ERROR_CODES.INVALID_INPUT, "本文のないイベントは解釈しません。");
    }

    // 2. 安定ID。再試行で作り直さない（ADR-006）。時刻はISO文字列で渡す
    //    （computeRequestHash は Date を拒否する）。
    const requestId = `${stored.caseId}:${input.inboundEventId}:INTERPRET_REPLY:${attempt}`;
    const offer = {
      date: caseSnapshot.businessDate,
      roleCode: caseSnapshot.roleCode,
      startAt: outreach.offeredStartAt,
      endAt: outreach.offeredEndAt,
      deadlineAt: caseSnapshot.deadlineAt,
    };
    const requestHash = computeRequestHash({
      schemaVersion: MODEL_OUTPUT_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      offer,
      currentCommitment: current ? { startAt: current.startAt, endAt: current.endAt } : null,
      afterCommit,
      replyText: stored.event.body,
    });

    // 3. 外部作用。取引の内側から呼ぶと、HTTP待ちの間ロックを持つ（RFC-010 §5）。
    assertOutsideTransaction("モデル呼出し");
    let response;
    try {
      response = await deps.model.interpretReply({
        requestId,
        requestHash,
        step: "INTERPRET_REPLY",
        attempt,
        caseId: stored.caseId,
        runId: caseSnapshot.runId,
        anonymousStaffRef: outreach.anonymousStaffRef,
        offer,
        currentCommitment: current ? { startAt: current.startAt, endAt: current.endAt } : undefined,
        afterCommit,
        replyText: stored.event.body,
        promptVersion: PROMPT_VERSION,
      });
    } catch (error) {
      if (error instanceof TaskcalError) {
        // NOT_CONFIGURED / BUDGET_EXCEEDED / RECONCILE_REQUIRED はいずれも
        // 「解釈できていない」。案件状態を動かさず、事実だけを記録する。
        await withTransaction((tx) =>
          deps.cases.recordEvent(tx, {
            caseId: stored.caseId,
            kind: "INTERPRETATION_UNAVAILABLE",
            detail: { code: error.code, receivedSeq: stored.receivedSeq },
          }),
        );
        return fail(error.code, error.message);
      }
      throw error;
    }

    // 4. 決定的検査。モデルの提案をそのまま採用しない。
    const now = deps.clock.now();
    const intent = response.output.interpretation.intent;
    const check =
      intent === "ACCEPT" || intent === "CONDITIONAL" || intent === "CORRECTION"
        ? checkOfferedRange({
            output: response.output,
            offeredStartAt: outreach.offeredStartAt,
            offeredEndAt: outreach.offeredEndAt,
            deadlineAt: caseSnapshot.deadlineAt,
            now,
          })
        : ({ ok: false, reason: CHECK_REJECTION.NOT_AN_ACCEPT, detail: "" } as const);

    // 5. 適用。**順序が重要。**
    //    案件をロックして版を照合してから、受信順を進める。逆にすると、案件版が
    //    動いていた場合に「適用済み」の印だけが進み、未処理の返信（撤回・訂正を
    //    含む）が無かったことになる（D04・A05・A12）。
    //    このロック順（案件 → 打診）は受信経路と同じにする。逆にするとデッドロックする。
    return withTransaction(async (tx) => {
      const interpretationId = deps.ids.next();
      const record = {
        interpretationId,
        messageId,
        inboundEventId: input.inboundEventId,
        receivedSeq: stored.receivedSeq,
        caseVersion: caseSnapshot.version,
        requestId,
        output: response.output,
        maskedReplyText: response.maskedReplyText,
      };

      // D08：読んでから適用するまでに前提が変わっていないか。
      // 変わっていれば**受信順を進めずに**破棄する。未処理のまま残し、次の解釈で拾う。
      const fresh = await deps.cases.lockForUpdate(tx, stored.caseId);
      if (fresh === "NOT_FOUND" || fresh.version !== caseSnapshot.version) {
        await deps.interpretations.save(tx, record, INTERPRETATION_APPLICATION.DISCARDED_STALE);
        return { ok: true, applied: INTERPRETATION_APPLICATION.DISCARDED_STALE, intent };
      }

      const live = await deps.outreaches.findById(tx, outreach.outreachId);
      if (live === "NOT_FOUND") {
        await deps.interpretations.save(tx, record, INTERPRETATION_APPLICATION.DISCARDED_STALE);
        return { ok: true, applied: INTERPRETATION_APPLICATION.DISCARDED_STALE, intent };
      }

      const advanced = await deps.interpretations.tryAdvanceAppliedSeq(tx, {
        outreachId: live.outreachId,
        receivedSeq: stored.receivedSeq,
      });

      if (advanced === "STALE") {
        // 遅れて返った古い結果。保存はするが、承諾も状態も動かさない（A12）。
        await deps.interpretations.save(tx, record, INTERPRETATION_APPLICATION.DISCARDED_STALE);
        return { ok: true, applied: INTERPRETATION_APPLICATION.DISCARDED_STALE, intent };
      }

      // 終了・失効した打診への返信。記録するが承諾も遷移も作らない
      // （RFC-011 §4「期限後・終了後の返信は記録・適切な回答のみ」）。
      // 受信順は進める。進めないと、この受信を毎回選び直して前へ進めない。
      if (TERMINAL_OUTREACH_STATES.includes(live.state) || live.state === "EXPIRED") {
        await deps.interpretations.save(tx, record, INTERPRETATION_APPLICATION.REJECTED_BY_CHECK);
        await deps.cases.recordEvent(tx, {
          caseId: stored.caseId,
          kind: "REPLY_AFTER_OUTREACH_CLOSED",
          detail: { intent, receivedSeq: stored.receivedSeq },
        });
        return { ok: true, applied: INTERPRETATION_APPLICATION.REJECTED_BY_CHECK, intent };
      }

      const applied: InterpretationApplication = check.ok
        ? INTERPRETATION_APPLICATION.APPLIED
        : INTERPRETATION_APPLICATION.REJECTED_BY_CHECK;

      await deps.interpretations.save(tx, record, applied);

      // 確定後の変更申告は承諾を動かさない。元の勤務を保持して人へ返す（A13）。
      if (afterCommit) {
        await deps.cases.recordEvent(tx, {
          caseId: stored.caseId,
          kind: "CHANGE_REQUEST_AFTER_COMMIT",
          detail: { intent, receivedSeq: stored.receivedSeq },
        });
        return { ok: true, applied, intent };
      }

      // 承諾は取引の中で読み直す。取引外のスナップショットのまま閉じると、
      // 並行して作られた版を取りこぼす。
      const open = await latestOpenCommitment(deps, tx, stored.caseId, live.staffId);

      let commitmentId: string | undefined;
      let nextOutreachState = live.state;

      /** 旧承諾を閉じる。終端でない最新版だけを動かす。 */
      const closeOpen = async (to: "HELD" | "WITHDRAWN") => {
        if (open) {
          await deps.commitments.changeStatus(tx, { commitmentId: open.commitmentId, to });
        }
      };

      switch (intent) {
        case "ACCEPT":
        case "CONDITIONAL":
        case "CORRECTION": {
          if (check.ok) {
            commitmentId = deps.ids.next();
            await deps.commitments.createVersion(tx, {
              commitmentId,
              caseId: stored.caseId,
              staffId: live.staffId,
              outreachId: live.outreachId,
              supersedes: open?.commitmentId,
              roleCode: caseSnapshot.roleCode,
              startAt: check.startAt,
              endAt: check.endAt,
              acceptedInterpretationId: interpretationId,
              sourceReceivedSeq: stored.receivedSeq,
            });
            nextOutreachState = "ANSWERED";
          } else if (
            check.reason === CHECK_REJECTION.OUT_OF_SCOPE ||
            check.reason === CHECK_REJECTION.DEADLINE
          ) {
            // Q03・Q05・Q10は「範囲外として**明示的に**拒否」。期限後の返信は確定へ
            // 使わない（RFC-011 §4）。どちらも聞き直しても結果が変わらないので、
            // 追加確認へ畳まない——過ぎた期限や、そもそも扱えない条件を書いた確認を
            // 送り返すことになる。
            await closeOpen("HELD");
            nextOutreachState = "ANSWERED";
            await deps.cases.recordEvent(tx, {
              caseId: stored.caseId,
              kind:
                check.reason === CHECK_REJECTION.DEADLINE
                  ? "REPLY_AFTER_DEADLINE"
                  : "REPLY_OUT_OF_SCOPE",
              detail: { receivedSeq: stored.receivedSeq, detail: check.detail },
            });
          } else {
            // 条件が一意に定まらない。旧承諾があれば保留し、選定へ出さない
            // （RFC-011 §4「曖昧な変更」）。
            await closeOpen("HELD");
            nextOutreachState = "CLARIFYING";
          }
          break;
        }
        case "DECLINE": {
          await closeOpen("WITHDRAWN");
          nextOutreachState = "CLOSED";
          break;
        }
        case "WITHDRAW": {
          await closeOpen("WITHDRAWN");
          nextOutreachState = "ANSWERED";
          break;
        }
        case "UNCLEAR": {
          await closeOpen("HELD");
          nextOutreachState = "CLARIFYING";
          break;
        }
      }

      // Q09：曖昧な返信は確認へ回す。承諾に使えない返信も無視しない。
      if (nextOutreachState === "CLARIFYING") {
        const body = buildClarificationBody({
          storeName: store.name,
          roleLabel: caseSnapshot.roleCode,
          timeZone: store.timezone,
          startAt: live.offeredStartAt,
          endAt: live.offeredEndAt,
          deadlineAt: caseSnapshot.deadlineAt,
        });
        const payload: SendPayloadForHash = {
          to: live.endpoint,
          kind: "CLARIFICATION",
          body,
        };
        await deps.outbox.enqueue(tx, {
          outboxId: deps.ids.next(),
          caseId: stored.caseId,
          outreachId: live.outreachId,
          kind: "CLARIFICATION",
          body,
          // 同じ受信への確認は一つ。受信順をキーに含めて作り直さない（ADR-006）。
          operation: {
            operationId: `send:${live.outreachId}:CLARIFICATION:${stored.receivedSeq}`,
            requestHash: computeRequestHash(payload),
          },
          connectionId: caseSnapshot.connectionId,
        });
      }

      if (nextOutreachState !== live.state) {
        // tryAdvanceAppliedSeq が版を1つ進めている。
        const moved = await deps.outreaches.applyTransition(tx, {
          outreachId: live.outreachId,
          expectedVersion: live.version + 1,
          to: nextOutreachState,
        });
        if (moved === "VERSION_CONFLICT") {
          // 並行して打診が動いた。黙って進めない。承諾は作ってあるので、
          // 画面と実態がずれたことを記録して人が追えるようにする。
          await deps.cases.recordEvent(tx, {
            caseId: stored.caseId,
            kind: "OUTREACH_TRANSITION_CONFLICT",
            detail: { outreachId: live.outreachId, to: nextOutreachState },
          });
        }
      }

      return { ok: true, applied, intent, commitmentId };
    });
  };
}
