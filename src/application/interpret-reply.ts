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
import { INTERPRETATION_APPLICATION } from "../contracts/repository";
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
type CheckResult = { ok: true; startAt: string; endAt: string } | { ok: false; reason: string };

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
    return { ok: false, reason: "OUT_OF_SCOPE_SPLIT" };
  }
  if (input.output.interpretation.unresolvedConditions.length > 0) {
    return { ok: false, reason: "UNRESOLVED" };
  }
  if (Date.parse(input.now) >= Date.parse(input.deadlineAt)) {
    return { ok: false, reason: "DEADLINE" };
  }

  const { startAt, endAt } = ranges[0];
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
    return { ok: false, reason: "RANGE" };
  }
  if (startAt.slice(0, 10) !== endAt.slice(0, 10)) {
    return { ok: false, reason: "OVERNIGHT" };
  }
  const minutes = (end - start) / 60_000;
  if (minutes % TIME_GRANULARITY_MINUTES !== 0) {
    return { ok: false, reason: "GRANULARITY" };
  }
  if (minutes > MAX_ADDITIONAL_SHIFT_MINUTES) {
    return { ok: false, reason: "TOO_LONG" };
  }
  if (start < Date.parse(input.offeredStartAt) || end > Date.parse(input.offeredEndAt)) {
    return { ok: false, reason: "OUTSIDE_OFFER" };
  }
  return { ok: true, startAt, endAt };
}

export function interpretReply(deps: InterpretReplyDeps) {
  return async function run(input: InterpretReplyInput): Promise<InterpretReplyResult> {
    const attempt = input.attempt ?? 1;

    // 1. スナップショットを取引の外で読む。ここから呼出しまでに前提が変われば、
    //    適用の段で案件版を照合して弾く（D08）。
    const snapshot = await withTransaction(async (tx) => {
      const stored = await deps.inbound.findById(tx, input.inboundEventId);
      if (stored === "NOT_FOUND") return undefined;
      const outreach = await deps.outreaches.findByEndpoint(tx, stored.event.from);
      if (outreach === "NOT_FOUND") return undefined;
      const caseSnapshot = await deps.cases.findById(tx, stored.caseId);
      if (caseSnapshot === "NOT_FOUND") return undefined;
      const commitments = await deps.commitments.listByCase(tx, stored.caseId);
      const message = await tx.query<{ message_id: string }>(
        "select message_id from inbound_event where inbound_event_id = $1",
        [input.inboundEventId],
      );
      const store = await tx.query<{ name: string; timezone: string }>(
        "select name, timezone from store where store_id = $1",
        [caseSnapshot.storeId],
      );
      return {
        stored,
        outreach,
        caseSnapshot,
        current: commitments.find((c) => c.staffId === outreach.staffId && c.status === "ACTIVE"),
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
        : ({ ok: false, reason: "NOT_AN_ACCEPT" } as const);

    // 5. 適用。A12 のガードはここ。
    return withTransaction(async (tx) => {
      const interpretationId = deps.ids.next();
      const advanced = await deps.interpretations.tryAdvanceAppliedSeq(tx, {
        outreachId: outreach.outreachId,
        receivedSeq: stored.receivedSeq,
      });

      if (advanced === "STALE") {
        // 遅れて返った古い結果。保存はするが、承諾も状態も動かさない。
        await deps.interpretations.save(
          tx,
          {
            interpretationId,
            messageId,
            inboundEventId: input.inboundEventId,
            receivedSeq: stored.receivedSeq,
            caseVersion: caseSnapshot.version,
            requestId,
            output: response.output,
            maskedReplyText: response.maskedReplyText,
          },
          INTERPRETATION_APPLICATION.DISCARDED_STALE,
        );
        return { ok: true, applied: INTERPRETATION_APPLICATION.DISCARDED_STALE, intent };
      }

      // D08：読んでから適用するまでに前提が変わっていないか。
      const fresh = await deps.cases.lockForUpdate(tx, stored.caseId);
      if (fresh === "NOT_FOUND" || fresh.version !== caseSnapshot.version) {
        await deps.interpretations.save(
          tx,
          {
            interpretationId,
            messageId,
            inboundEventId: input.inboundEventId,
            receivedSeq: stored.receivedSeq,
            caseVersion: caseSnapshot.version,
            requestId,
            output: response.output,
            maskedReplyText: response.maskedReplyText,
          },
          INTERPRETATION_APPLICATION.DISCARDED_STALE,
        );
        return { ok: true, applied: INTERPRETATION_APPLICATION.DISCARDED_STALE, intent };
      }

      const applied: InterpretationApplication = check.ok
        ? INTERPRETATION_APPLICATION.APPLIED
        : INTERPRETATION_APPLICATION.REJECTED_BY_CHECK;

      await deps.interpretations.save(
        tx,
        {
          interpretationId,
          messageId,
          inboundEventId: input.inboundEventId,
          receivedSeq: stored.receivedSeq,
          caseVersion: caseSnapshot.version,
          requestId,
          output: response.output,
          maskedReplyText: response.maskedReplyText,
        },
        applied,
      );

      // 確定後の変更申告は承諾を動かさない。元の勤務を保持して人へ返す（A13）。
      if (afterCommit) {
        await deps.cases.recordEvent(tx, {
          caseId: stored.caseId,
          kind: "CHANGE_REQUEST_AFTER_COMMIT",
          detail: { intent, receivedSeq: stored.receivedSeq },
        });
        return { ok: true, applied, intent };
      }

      let commitmentId: string | undefined;
      let nextOutreachState = outreach.state;

      switch (intent) {
        case "ACCEPT":
        case "CONDITIONAL":
        case "CORRECTION": {
          if (check.ok) {
            commitmentId = deps.ids.next();
            await deps.commitments.createVersion(tx, {
              commitmentId,
              caseId: stored.caseId,
              staffId: outreach.staffId,
              outreachId: outreach.outreachId,
              supersedes: current?.commitmentId,
              roleCode: caseSnapshot.roleCode,
              startAt: check.startAt,
              endAt: check.endAt,
              acceptedInterpretationId: interpretationId,
              sourceReceivedSeq: stored.receivedSeq,
            });
            nextOutreachState = "ANSWERED";
          } else {
            // 条件が一意に定まらない。旧承諾があれば保留し、選定へ出さない
            // （RFC-011 §4「曖昧な変更」）。
            if (current) {
              await deps.commitments.changeStatus(tx, {
                commitmentId: current.commitmentId,
                to: "HELD",
              });
            }
            nextOutreachState = "CLARIFYING";
          }
          break;
        }
        case "DECLINE": {
          if (current) {
            await deps.commitments.changeStatus(tx, {
              commitmentId: current.commitmentId,
              to: "WITHDRAWN",
            });
          }
          nextOutreachState = "CLOSED";
          break;
        }
        case "WITHDRAW": {
          if (current) {
            await deps.commitments.changeStatus(tx, {
              commitmentId: current.commitmentId,
              to: "WITHDRAWN",
            });
          }
          nextOutreachState = "ANSWERED";
          break;
        }
        case "UNCLEAR": {
          if (current) {
            await deps.commitments.changeStatus(tx, {
              commitmentId: current.commitmentId,
              to: "HELD",
            });
          }
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
          startAt: outreach.offeredStartAt,
          endAt: outreach.offeredEndAt,
          deadlineAt: caseSnapshot.deadlineAt,
        });
        const payload: SendPayloadForHash = {
          to: outreach.endpoint,
          kind: "CLARIFICATION",
          body,
        };
        await deps.outbox.enqueue(tx, {
          outboxId: deps.ids.next(),
          caseId: stored.caseId,
          outreachId: outreach.outreachId,
          kind: "CLARIFICATION",
          body,
          // 同じ受信への確認は一つ。受信順をキーに含めて作り直さない（ADR-006）。
          operation: {
            operationId: `send:${outreach.outreachId}:CLARIFICATION:${stored.receivedSeq}`,
            requestHash: computeRequestHash(payload),
          },
          connectionId: caseSnapshot.connectionId,
        });
      }

      if (nextOutreachState !== outreach.state) {
        // tryAdvanceAppliedSeq が版を1つ進めている。
        await deps.outreaches.applyTransition(tx, {
          outreachId: outreach.outreachId,
          expectedVersion: outreach.version + 1,
          to: nextOutreachState,
        });
      }

      return { ok: true, applied, intent, commitmentId };
    });
  };
}
