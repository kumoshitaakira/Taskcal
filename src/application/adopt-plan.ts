/**
 * 正式採用の進行（RFC-010 §4 の手順1〜7、RFC-009 D05・D06・D08・D09、A02〜A08）。
 *
 * 取引の分け方（RFC-010 §4・§5）：
 *
 *   手順1-2  外   案件・承諾・正式版参照・月内入力の完全性を読む
 *   選定固定 取引A 選定結果を不変で保存し、勤務表更新を PREPARING で作る
 *   手順3    外   `applyUpdate`（外部作用）。**取引の中で呼ばない**
 *   手順4    外   `readBack` で成果物を検査して PREPARED
 *   手順5-6  取引B 直前再検査 → 勤務・正式版参照・採用事実・操作結果・通知待ちを**一括**保存
 *   手順7    外   正式版参照から読み直して照合し、通知処理へ進む
 *
 * 守る規則：
 *   - D06／A08：手順6は一つの取引。どこかで失敗したら全件巻き戻す。一部だけを
 *     正式勤務にしない。
 *   - D08／A05：手順5で案件版・停止・期限・入力版・承諾の版・未処理返信・月次完全性を
 *     **もう一度**検査する。選定時に通ったことを再利用しない。
 *   - A03／D09：`applyUpdate` の成否が不明なら**再実行しない**。`getUpdateResult` で
 *     照合できるまで `RECONCILE_REQUIRED` に留め、未採用と断定しない。
 *   - A04：正式版参照は期待版付きで差し替える。同じ旧版から作った二つの計画の
 *     一方だけを通す。別の操作キーでも二重採用しない（D05の部分一意索引）。
 *   - A07：読戻しが一致しなければ採用しない。完了にもしない。
 *   - D09：読戻し・通知が失敗しても確定済みの勤務と採用事実を消さない。
 *
 * 操作IDは二つ使う。用途が違うため一つに畳まない。
 *   - `command.operationId`（`ADOPT_PLAN`）：画面の操作の冪等キー。**描画ごとに作る**
 *     （`adopt:{caseId}:{uuid}`）ので、同じ操作になるのは**同じ描画内の二重クリックだけ**。
 *     再読込は別の操作になる。内容から決めてしまうと、未実装で一度断った案件を、
 *     実装が入った後も同じ拒否で返し続ける。再読込後の続きは `findOpenByCase` が拾う。
 *   - `applyOperationId(selectionId)`（`APPLY_UPDATE`）：**外部作用**の冪等キー。
 *     不変の選定結果から決まるので、プロセスが落ちて再開しても同じ値になり、
 *     `getUpdateResult` で同じ操作の結果を照会できる（RFC-010 §7）。
 */

import "server-only";
import { assertOutsideTransaction, withTransaction, type Tx } from "../adapters/db/transaction";
import { loadLatestMonthlyEligibility } from "../adapters/db/monthly-eligibility";
import type { ScheduleReadRepository } from "../adapters/db/schedule-repository";
import {
  ADOPTION_FACT,
  handoffReasonOf,
  isAllowedCaseTransition,
  resolveCaseReconcile,
  resolvePreparingStop,
  type CaseState,
  type Handoff,
} from "../contracts/case-state";
import { isSelectableCommitment, type Commitment } from "../contracts/commitment";
import { ERROR_CODES, TaskcalError, type ErrorCode } from "../contracts/errors";
import type { SendPayloadForHash } from "../contracts/messaging-gateway";
import { computeRequestHash, type RequestHash } from "../contracts/operation";
import type {
  AbsenceCaseRepository,
  AuthoritativeScheduleRefRepository,
  CaseSnapshot,
  Clock,
  CommitmentRepository,
  IdGenerator,
  InboundEventRepository,
  OperationResultStore,
  OutboxRepository,
  OutreachRepository,
  ScheduleUpdateRepository,
  StoreRepository,
  ScheduleUpdateSnapshot,
  SelectionResultRepository,
  ShiftAssignmentRepository,
  StaffRepository,
} from "../contracts/repository";
import type {
  ApplyUpdatePayloadForHash,
  LoadedSchedule,
  PlannedAbsence,
  PlannedAssignment,
  ScheduleGateway,
  UpdateResult,
} from "../contracts/schedule-gateway";
import {
  RECONCILE_FINDING,
  isOutcomeUnknown,
  resolveReconcile,
  type ReconcileFinding,
  type UpdateResultKind,
} from "../contracts/schedule-update";
import type {
  EligibilityChecker,
  EligibilityRecheckResult,
  SelectionCandidate,
  SelectionInputs,
  SelectionPlanner,
  SelectionResult,
} from "../contracts/selection";
import {
  matchesExpected,
  plannedAbsences,
  plannedAdditions,
  toJstTimestamp,
  verifyAdoptedArtifact,
} from "./adoption-check";
import {
  buildCaseClosedBody,
  buildConfirmationBody,
  buildNotSelectedBody,
  type OfferContext,
} from "./offer-message";
import { sendOperationId } from "./start-outreach";
import { buildRecheckInput } from "./eligibility-recheck";

export interface AdoptPlanCommand {
  /** 画面が描画時に作ったキー。同じ描画内の二重クリックだけが同じ値になる。 */
  readonly operationId: string;
  readonly caseId: string;
}

export type AdoptPlanResult =
  | {
      readonly ok: true;
      readonly outcome: "ADOPTED";
      readonly scheduleUpdateId: string;
      /** 正式勤務にした件数。 */
      readonly adopted: number;
      /** 手順7の照合が一致したか。一致しなければ要対応（A07／D09）。 */
      readonly readBackMatches: boolean;
      readonly replayed: boolean;
    }
  | {
      readonly ok: true;
      readonly outcome: "NOT_FEASIBLE";
      readonly selectionId: string;
      readonly reason: string;
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly detail: string;
      /** 勤務表更新をどう確定させたか。未確定のまま返さない。 */
      readonly outcome?: "REJECTED" | "RECONCILE_REQUIRED";
    };

export interface AdoptPlanDeps {
  readonly cases: AbsenceCaseRepository;
  readonly commitments: CommitmentRepository;
  readonly outreaches: OutreachRepository;
  readonly inbound: InboundEventRepository;
  readonly stores: StoreRepository;
  /** Q15：適格性の再検査へ渡すスタッフ条件を読む。 */
  readonly staff: StaffRepository;
  readonly selections: SelectionResultRepository;
  readonly scheduleUpdates: ScheduleUpdateRepository;
  readonly authoritative: AuthoritativeScheduleRefRepository;
  readonly assignments: ShiftAssignmentRepository;
  readonly schedules: ScheduleReadRepository;
  readonly outbox: OutboxRepository;
  readonly operations: OperationResultStore;
  readonly gateway: ScheduleGateway;
  readonly planner: SelectionPlanner;
  /** D08：正式採用の直前にもう一度通す。選定時の結果を再利用しない。 */
  readonly eligibility: Pick<EligibilityChecker, "recheck">;
  readonly loadMonthlyEligibility?: typeof loadLatestMonthlyEligibility;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** 外部作用（`applyUpdate`）の冪等キー。不変の選定結果から決まる。 */
export function applyOperationId(selectionId: string): string {
  return `apply:${selectionId}`;
}

type Failure = {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly detail: string;
  readonly outcome?: "REJECTED" | "RECONCILE_REQUIRED";
};

function fail(
  code: ErrorCode,
  detail: string,
  outcome?: "REJECTED" | "RECONCILE_REQUIRED",
): Failure {
  return { ok: false, code, detail, ...(outcome ? { outcome } : {}) };
}

/**
 * 検査で弾いたことを操作結果へ確定させる。
 *
 * **IN_PROGRESS のまま閉じない。** 外部作用の前に自分で弾いた結果は**確定した拒否**
 * であり、成否不明ではない。残すと以後の再実行がすべて「結果不明」になる。
 */
async function refuse(
  operations: OperationResultStore,
  tx: Tx,
  operationId: string,
  code: ErrorCode,
  detail: string,
): Promise<Failure> {
  await operations.complete(tx, { operationId, status: "REFUSED", result: { code, detail } });
  return fail(code, detail);
}

/**
 * adapter が外部作用の前に断ったか。
 *
 * `ScheduleGateway` の例外は原則「成否不明」だが、未実装・未設定はその例外
 * （`src/contracts/schedule-gateway.ts` 参照）。未実装を成否不明として扱うと、
 * まだ何も繋がっていない案件が全て照合待ちになり、本当の結果不明と区別できない。
 */
function isRefusedBeforeEffect(error: unknown): error is TaskcalError {
  return (
    error instanceof TaskcalError &&
    (error.code === ERROR_CODES.NOT_IMPLEMENTED || error.code === ERROR_CODES.NOT_CONFIGURED)
  );
}

/**
 * 採用取引を巻き戻すための合図。
 *
 * **取引の中で確定結果を書けない。** 手順6の途中で前提が崩れたら取引ごと巻き戻す
 * 必要があり（D06／A08）、その同じ取引で「拒否した」と書いても一緒に消える。
 * 巻き戻した**後**に別取引で確定させるため、理由をここへ載せて外まで運ぶ。
 *
 * 素の `Error` にしない。想定外の例外（バグ・接続断）と、こちらが意図して巻き戻した
 * ものを取り違えると、未採用と断定してよいかの判断が変わる。
 */
class AdoptRollback extends Error {
  readonly code: ErrorCode;
  /** 他の実行がすでに採用済み。未採用として上書きしてはいけない（A04）。 */
  readonly alreadyAdopted: boolean;

  constructor(code: ErrorCode, message: string, alreadyAdopted = false) {
    super(message);
    this.name = "AdoptRollback";
    this.code = code;
    this.alreadyAdopted = alreadyAdopted;
  }
}

type PrepareOutcome =
  | { readonly kind: "FAILED"; readonly result: Failure }
  | { readonly kind: "NOT_FEASIBLE"; readonly result: AdoptPlanResult }
  | {
      readonly kind: "PREPARED";
      readonly update: ScheduleUpdateSnapshot;
      readonly selection: SelectionResult;
      readonly requestHash: RequestHash;
      readonly baseArtifactRef?: string;
      readonly additions: readonly PlannedAssignment[];
      readonly absences: readonly PlannedAbsence[];
    };

export function adoptPlan(deps: AdoptPlanDeps) {
  /**
   * 案件の状態を動かす。**遷移表が繋がっていない経路を無理に一段で通さない。**
   *
   * `PREPARING` から `ATTENTION` への直行は許していない（RFC-011 §5）。照合が
   * 継続不能なときは、まず `RECONCILE_REQUIRED` へ入れてから要対応へ回す。
   * 一段で書こうとして遷移表を緩めると、照合していない案件が要対応へ飛べてしまう。
   */
  async function moveCase(
    tx: Tx,
    snapshot: CaseSnapshot,
    to: CaseState,
    extra: { adoptionFact?: (typeof ADOPTION_FACT)[keyof typeof ADOPTION_FACT]; handoff?: Handoff },
  ): Promise<
    | { readonly moved: true; readonly version: number }
    | { readonly moved: false; readonly reason: "VERSION_CONFLICT" | "NOT_ALLOWED" }
  > {
    if (to === snapshot.state) return { moved: true, version: snapshot.version };

    if (snapshot.state === "PREPARING" && to === "ATTENTION") {
      const first = await deps.cases.applyTransition(tx, {
        caseId: snapshot.caseId,
        expectedVersion: snapshot.version,
        to: "RECONCILE_REQUIRED",
        adoptionFact: extra.adoptionFact,
      });
      if (first === "VERSION_CONFLICT") return { moved: false, reason: "VERSION_CONFLICT" };
      const second = await deps.cases.applyTransition(tx, {
        caseId: snapshot.caseId,
        expectedVersion: snapshot.version + 1,
        to: "ATTENTION",
        adoptionFact: extra.adoptionFact,
        handoff: extra.handoff,
      });
      return second === "UPDATED"
        ? { moved: true, version: snapshot.version + 2 }
        : { moved: false, reason: "VERSION_CONFLICT" };
    }

    // 遷移表に無い行き先は**書こうとしない**。`applyTransition` は例外を投げるので、
    // ここで弾かないと「拒否を記録しようとして落ちる」経路になる（並行採用のとき）。
    if (!isAllowedCaseTransition(snapshot.state, to)) {
      return { moved: false, reason: "NOT_ALLOWED" };
    }
    const moved = await deps.cases.applyTransition(tx, {
      caseId: snapshot.caseId,
      expectedVersion: snapshot.version,
      to,
      adoptionFact: extra.adoptionFact,
      handoff: extra.handoff,
    });
    return moved === "UPDATED"
      ? { moved: true, version: snapshot.version + 1 }
      : { moved: false, reason: "VERSION_CONFLICT" };
  }

  /** 通知待ちを積む。宛先は打診時に固定した版をそのまま使う（A15）。 */
  async function enqueueNotifications(
    tx: Tx,
    input: { snapshot: CaseSnapshot; selection: SelectionResult },
  ): Promise<void> {
    const store = await deps.stores.findById(tx, input.snapshot.storeId);
    if (store === "NOT_FOUND") {
      throw new TaskcalError(ERROR_CODES.INVALID_INPUT, "店舗が見つかりません。");
    }

    const outreaches = await deps.outreaches.listByCase(tx, input.snapshot.caseId);
    const commitments = await deps.commitments.listByCase(tx, input.snapshot.caseId);

    const selectedByOutreach = new Map<string, { startAt: string; endAt: string }>();
    for (const chosen of input.selection.selected) {
      const commitment = commitments.find((c) => c.commitmentId === chosen.commitmentId);
      if (commitment) {
        selectedByOutreach.set(commitment.outreachId, {
          startAt: chosen.startAt,
          endAt: chosen.endAt,
        });
      }
    }
    const notSelected = new Set(
      input.selection.notSelectedCommitmentIds
        .map((id) => commitments.find((c) => c.commitmentId === id)?.outreachId)
        .filter((id): id is string => Boolean(id)),
    );

    for (const outreach of outreaches) {
      const chosen = selectedByOutreach.get(outreach.outreachId);
      const notSelectedHere = notSelected.has(outreach.outreachId);
      // **打診が届いたと確認できていない相手へ「募集終了」を送らない。**
      // 初回打診が送信待ちのまま残っていると、同じ受信箱に「打診」と「終了しました」が
      // 続けて入る。届いたと確認できるまで動かさない方針（A11）と向きをそろえる。
      if (!chosen && !notSelectedHere && outreach.state === "PENDING_SEND") {
        await deps.cases.recordEvent(tx, {
          caseId: input.snapshot.caseId,
          kind: "CASE_CLOSED_SKIPPED",
          detail: { outreachId: outreach.outreachId, reason: "NOT_DELIVERED" },
        });
        continue;
      }
      const kind = chosen
        ? "CONFIRMATION"
        : notSelectedHere
          ? "NOT_SELECTED"
          : // Q07：返信が無かった相手も待たせない。募集が終わったことを伝える。
            "CASE_CLOSED";
      const context: OfferContext = {
        storeName: store.name,
        roleLabel: input.snapshot.roleCode,
        timeZone: store.timezone,
        // 確定通知は本人の確定区間。必要枠そのものとは限らない。
        startAt: chosen?.startAt ?? input.snapshot.requiredStartAt,
        endAt: chosen?.endAt ?? input.snapshot.requiredEndAt,
        deadlineAt: input.snapshot.deadlineAt,
      };
      const body =
        kind === "CONFIRMATION"
          ? buildConfirmationBody(context)
          : kind === "NOT_SELECTED"
            ? buildNotSelectedBody(context)
            : buildCaseClosedBody(context);
      // 宛先を丸ごとハッシュに含める。接続先だけ切り替えた再試行を別要求として
      // 検出するため（A15）。
      const payload: SendPayloadForHash = { to: outreach.endpoint, kind, body };
      await deps.outbox.enqueue(tx, {
        outboxId: deps.ids.next(),
        caseId: input.snapshot.caseId,
        outreachId: outreach.outreachId,
        kind,
        body,
        operation: {
          operationId: sendOperationId(outreach.outreachId, kind),
          requestHash: computeRequestHash(payload),
        },
        connectionId: input.snapshot.connectionId,
      });
    }
  }

  /**
   * 手順5-6：直前再検査と一括保存。**ここが唯一の取引。**
   *
   * 照合結果を `resolveReconcile` と `resolveCaseReconcile` の**両方**へ渡す。片方だけで
   * 状態を決めると、更新は採用済みなのに案件は調整中、といった食い違いができる（ADR-022）。
   */
  async function adopt(input: {
    /** 成果物と新しい版が確定していること。手順4を通していない更新を渡さない。 */
    update: ScheduleUpdateSnapshot & { artifactRef: string; newSourceRevision: string };
    selection: SelectionResult;
    operationId: string;
    /**
     * D08：**採用の直前に取り直した**月内勤務表。選定時に固定した値ではない。
     * 適格性の再検査（Q15）はこれを見る。
     */
    reloaded: LoadedSchedule;
  }): Promise<
    | { readonly ok: true; readonly adopted: number }
    | Failure
    | { readonly ok: false; readonly rolledBack: AdoptRollback }
  > {
    const now = deps.clock.now();
    try {
      return await withTransaction(async (tx) => {
        // ADR-006 のロック順：store → case → staff。案件行を取って直列化する。
        const snapshot = await deps.cases.lockForUpdate(tx, input.update.caseId);
        if (snapshot === "NOT_FOUND") {
          return refuse(
            deps.operations,
            tx,
            input.operationId,
            ERROR_CODES.INVALID_INPUT,
            "案件が見つかりません。",
          );
        }

        /** 前提が崩れた。成果物は未採用として保持し、勤務照会に混ぜない（RFC-010 §4）。 */
        const rejected = async (code: ErrorCode, detail: string): Promise<Failure> => {
          const finding = RECONCILE_FINDING.CONFIRMED_NOT_ADOPTED;
          // Q13／ADR-022：`PREPARING` 中の停止は行き先が変わる。期限検知だけで
          // 引き継がず、並行する正式採用の結果（ここでは未採用と確定）を先に決める。
          const to =
            snapshot.stoppedAt && snapshot.state === "PREPARING"
              ? resolvePreparingStop({
                  adoptionFact: ADOPTION_FACT.NOT_ADOPTED,
                  cause: snapshot.stopCause ?? "MANAGER_STOP",
                })
              : resolveCaseReconcile({
                  finding,
                  lookupStillPossible: deps.gateway.capabilities.supportsResultLookup,
                });
          const moved = await moveCase(tx, snapshot, to, {
            adoptionFact: ADOPTION_FACT.NOT_ADOPTED,
            handoff:
              to === "HANDED_OFF"
                ? {
                    reason: handoffReasonOf(snapshot.stopCause ?? "MANAGER_STOP"),
                    adoptionFact: ADOPTION_FACT.NOT_ADOPTED,
                    handedOffAt: now,
                  }
                : undefined,
          });
          if (!moved.moved) {
            // 並行する実行がすでに案件を動かしている（採用済みかもしれない）。
            // **未採用として上書きしない。** 自分の拒否だけを記録して引き下がる。
            await refuse(deps.operations, tx, input.operationId, code, detail);
            return fail(code, detail);
          }
          const advanced = await deps.scheduleUpdates.advance(tx, {
            scheduleUpdateId: input.update.scheduleUpdateId,
            to: resolveReconcile(finding),
            caseVersion: moved.version,
          });
          if (advanced !== "UPDATED") {
            // 更新がすでに終端（採用済み・不採用）。ここで未採用と書き換えない。
            await refuse(deps.operations, tx, input.operationId, code, detail);
            return fail(code, detail);
          }
          await deps.cases.recordEvent(tx, {
            caseId: snapshot.caseId,
            kind: "ADOPT_REJECTED",
            detail: { code, scheduleUpdateId: input.update.scheduleUpdateId },
          });
          await refuse(deps.operations, tx, input.operationId, code, detail);
          // 未採用として確定させた。呼出し元が「結果不明」と取り違えないよう明示する。
          return fail(code, detail, "REJECTED");
        };

        // --- 手順5：直前再検査（D08）。選定時に通ったことを再利用しない。 ---
        if (snapshot.stoppedAt) {
          // D10：停止後は正式採用を行わない。確定済みの事実は保持する。
          return rejected(ERROR_CODES.CASE_STOPPED, "停止済みの案件です。正式採用は行いません。");
        }
        if (snapshot.version !== input.update.caseVersion) {
          // 準備を始めた後に別の変更が入っている（A04・A05）。
          return rejected(
            ERROR_CODES.REVISION_CONFLICT,
            "準備を始めてから案件が更新されています。選び直してください。",
          );
        }
        if (Date.parse(now) >= Date.parse(snapshot.deadlineAt)) {
          return rejected(ERROR_CODES.DEADLINE_EXCEEDED, "回答期限を過ぎています。");
        }
        if (input.selection.inputs.monthlyCompleteness !== "COMPLETE") {
          // Q06／A09：欠けた日を0と推定しない。完全でなければ月次検査が成立しない。
          return rejected(
            ERROR_CODES.INVALID_INPUT,
            "月内入力が完全ではありません。月次上限を検査できません。",
          );
        }

        const ref = await deps.authoritative.get(tx, {
          connectionId: snapshot.connectionId,
          scheduleId: snapshot.scheduleId,
        });
        if (ref === "NOT_FOUND") {
          return rejected(ERROR_CODES.INVALID_INPUT, "正式版参照がありません。");
        }
        if (ref.sourceRevision !== input.selection.inputs.sourceRevision) {
          // A04：選定の入力版と現在の正式版が違う。別の採用が先に通っている。
          return rejected(
            ERROR_CODES.REVISION_CONFLICT,
            "選定したときの勤務表と現在の正式版が異なります。",
          );
        }

        const commitments = await deps.commitments.listByCase(tx, snapshot.caseId);
        const byId = new Map(commitments.map((c) => [c.commitmentId, c] as const));
        const supersededBy = new Map<string, string>();
        for (const c of commitments) {
          if (c.supersedes) supersededBy.set(c.supersedes, c.commitmentId);
        }
        // 承諾はID順に見る。ロック順を固定しないと、同時に走る2本が互いを待つ（ADR-006）。
        const selectedIds = input.selection.selected
          .map((s) => s.commitmentId)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (const commitmentId of selectedIds) {
          const commitment = byId.get(commitmentId);
          if (!commitment) {
            return rejected(ERROR_CODES.INVALID_INPUT, "選定した承諾が見つかりません。");
          }
          const chosen = input.selection.selected.find((s) => s.commitmentId === commitmentId);
          if (!chosen || chosen.commitmentVersion !== commitment.version) {
            // D04：status だけでなく版まで一致させる。訂正を見落とさない（A05）。
            return rejected(ERROR_CODES.REVISION_CONFLICT, "承諾が選定時から変わっています。");
          }
          // D04：status 単独で判定しない。未処理の新しい返信・置換・期限も見る（A05）。
          const selectable = isSelectableCommitment({
            status: commitment.status,
            supersededBy: supersededBy.get(commitmentId),
            hasUnprocessedReply: await deps.inbound.hasUnprocessed(tx, commitment.outreachId),
            deadlineAt: snapshot.deadlineAt,
            now,
          });
          if (!selectable.selectable) {
            return rejected(
              ERROR_CODES.REVISION_CONFLICT,
              `承諾を選定できません（${selectable.reason}）。`,
            );
          }
        }

        // D08：可能時間・月次上限・重複をもう一度検査する。入力は採用直前にDBから
        // 取り直し、確認できない場合は採用を止める。
        let rechecked: EligibilityRecheckResult;
        try {
          if (deps.loadMonthlyEligibility) {
            const latest = await deps.loadMonthlyEligibility(tx, {
              storeId: snapshot.storeId,
              businessDate: snapshot.businessDate,
            });
            rechecked = deps.eligibility.recheck({
              storeId: snapshot.storeId,
              businessDate: snapshot.businessDate,
              requirement: {
                roleCode: snapshot.roleCode,
                startAt: toJstTimestamp(snapshot.requiredStartAt),
                endAt: toJstTimestamp(snapshot.requiredEndAt),
              },
              selected: input.selection.selected,
              inputs: input.selection.inputs,
              monthlySchedule: latest.monthlySchedule,
              staffProfiles: latest.staffProfiles,
              absentStaffId: snapshot.absentStaffId,
            });
          } else {
            const store = await deps.stores.findById(tx, snapshot.storeId);
            if (store === "NOT_FOUND") {
              return rejected(ERROR_CODES.INVALID_INPUT, "店舗が見つかりません。");
            }
            const conditions = await deps.staff.listConditionsByStore(tx, snapshot.storeId);
            rechecked = deps.eligibility.recheck(
              buildRecheckInput({
                snapshot,
                storeTimezone: store.timezone,
                reloaded: input.reloaded,
                conditions,
                selected: input.selection.selected,
                inputs: input.selection.inputs,
              }),
            );
          }
        } catch (error) {
          return rejected(
            ERROR_CODES.INVALID_INPUT,
            error instanceof Error ? error.message : "最新の月内勤務を検査できません。",
          );
        }
        if (!rechecked.ok) {
          // 誰が外れたかまで残す。理由だけだと、どの候補を見直せばよいか分からない。
          return rejected(
            ERROR_CODES.INVALID_INPUT,
            `適格性の再検査で外れました（${rechecked.reason}${
              rechecked.staffId ? `／staffId=${rechecked.staffId}` : ""
            }）。`,
          );
        }

        // --- 手順6：一括保存。ここから先の失敗は取引ごと巻き戻す（D06／A08）。 ---
        for (const chosen of input.selection.selected) {
          const commitment = byId.get(chosen.commitmentId) as Commitment;
          const added = await deps.assignments.addAdditional(tx, {
            shiftAssignmentId: chosen.plannedShiftAssignmentId,
            scheduleId: snapshot.scheduleId,
            storeId: snapshot.storeId,
            staffId: chosen.staffId,
            roleCode: snapshot.roleCode,
            startAt: chosen.startAt,
            endAt: chosen.endAt,
            sourceCaseId: snapshot.caseId,
            sourceCommitmentId: commitment.commitmentId,
          });
          if (added !== "INSERTED") {
            // A08：一部だけを正式勤務にしない。取引ごと巻き戻す。
            throw new AdoptRollback(
              ERROR_CODES.OPERATION_CONFLICT,
              `代替勤務を追加できません（${added}）。全件を未採用のまま戻します。`,
            );
          }
        }

        // 元勤務を欠勤にする。CANCELLED（勤務自体が無くなった）と混同しない。
        const absent = await deps.assignments.markAbsent(tx, {
          shiftAssignmentId: snapshot.absentShiftAssignmentId,
        });
        if (absent !== "UPDATED") {
          throw new AdoptRollback(
            ERROR_CODES.OPERATION_CONFLICT,
            "欠勤にする元勤務が予定済みではありません。全件を未採用のまま戻します。",
          );
        }

        // A04：期待版付きで正式版参照を差し替える。読んでから書くまでの間に別の採用が
        // 通っていれば、1行も更新されない。
        const swapped = await deps.authoritative.swap(tx, {
          connectionId: snapshot.connectionId,
          scheduleId: snapshot.scheduleId,
          expectedVersion: ref.version,
          // 旧版へ落とさない。成果物と新しい版は呼出し元が確定させている。
          // `?? ref.*` で埋めると、勤務だけ増えて正式版参照は古いまま残る。
          sourceRevision: input.update.newSourceRevision,
          artifactRef: input.update.artifactRef,
          adoptedAt: now,
          adoptedByScheduleUpdateId: input.update.scheduleUpdateId,
        });
        if (swapped === "REVISION_CONFLICT") {
          throw new AdoptRollback(
            ERROR_CODES.REVISION_CONFLICT,
            "正式版参照が別の採用で切り替わりました。全件を未採用のまま戻します。",
          );
        }

        const finding: ReconcileFinding = RECONCILE_FINDING.CONFIRMED_ADOPTED;
        const advanced = await deps.scheduleUpdates.advance(tx, {
          scheduleUpdateId: input.update.scheduleUpdateId,
          to: resolveReconcile(finding),
          adoptedAt: now,
        });
        if (advanced !== "UPDATED") {
          // D05／A04：この案件はすでに別の計画を採用している。別キーでも通さない。
          throw new AdoptRollback(
            ERROR_CODES.OPERATION_CONFLICT,
            `勤務表更新を採用済みにできません（${advanced}）。全件を未採用のまま戻します。`,
            // D05：この案件はすでに別の計画を採用している。未採用として上書きしない。
            advanced === "ALREADY_ADOPTED",
          );
        }

        // ADR-022：採用事実は案件状態と別に記録する。状態から推定させない。
        const moved = await moveCase(
          tx,
          snapshot,
          resolveCaseReconcile({
            finding,
            lookupStillPossible: deps.gateway.capabilities.supportsResultLookup,
          }),
          { adoptionFact: ADOPTION_FACT.ADOPTED },
        );
        if (!moved.moved) {
          throw new AdoptRollback(
            ERROR_CODES.OPERATION_CONFLICT,
            `案件を確定済みへ進められません（${moved.reason}）。全件を未採用のまま戻します。`,
          );
        }

        // Q07：確定通知・非選定通知・募集終了通知を同じ取引で積む。送信は取引の外。
        await enqueueNotifications(tx, { snapshot, selection: input.selection });

        await deps.cases.recordEvent(tx, {
          caseId: snapshot.caseId,
          kind: "PLAN_ADOPTED",
          detail: {
            scheduleUpdateId: input.update.scheduleUpdateId,
            selectionId: input.selection.selectionId,
            adopted: input.selection.selected.length,
          },
        });
        await deps.operations.complete(tx, {
          operationId: input.operationId,
          status: "SUCCEEDED",
          result: {
            outcome: "ADOPTED",
            scheduleUpdateId: input.update.scheduleUpdateId,
            adopted: input.selection.selected.length,
          },
        });

        return { ok: true as const, adopted: input.selection.selected.length };
      });
    } catch (error) {
      // 取引は巻き戻った（勤務は1件も残っていない：A08）。確定結果はこの外で書く。
      // 想定外の例外はそのまま投げる——巻き戻したことと、原因が分からないことは別。
      if (error instanceof AdoptRollback) return { ok: false as const, rolledBack: error };
      throw error;
    }
  }

  /** 手順1-2・選定固定。 */
  async function prepare(command: AdoptPlanCommand): Promise<PrepareOutcome> {
    const now = deps.clock.now();

    const head = await withTransaction(async (tx) => {
      const snapshot = await deps.cases.findById(tx, command.caseId);
      if (snapshot === "NOT_FOUND") return "NOT_FOUND" as const;
      const ref = await deps.authoritative.get(tx, {
        connectionId: snapshot.connectionId,
        scheduleId: snapshot.scheduleId,
      });
      return { snapshot, ref };
    });

    const refuseNow = async (code: ErrorCode, detail: string): Promise<PrepareOutcome> => ({
      kind: "FAILED",
      result: await withTransaction((tx) =>
        refuse(deps.operations, tx, command.operationId, code, detail),
      ),
    });

    if (head === "NOT_FOUND") {
      return refuseNow(ERROR_CODES.INVALID_INPUT, "案件が見つかりません。");
    }
    const { snapshot, ref } = head;
    if (ref === "NOT_FOUND") {
      return refuseNow(
        ERROR_CODES.INVALID_INPUT,
        "正式版参照がありません。勤務表を取り込んでください。",
      );
    }
    // 外部作用の前に弾く。D10：停止後は正式採用を行わない。
    if (snapshot.stoppedAt) {
      return refuseNow(ERROR_CODES.CASE_STOPPED, "停止済みの案件です。正式採用は行いません。");
    }
    if (snapshot.state !== "COORDINATING") {
      return refuseNow(
        ERROR_CODES.INVALID_INPUT,
        `調整中の案件ではありません（現在: ${snapshot.state}）。`,
      );
    }
    if (Date.parse(now) >= Date.parse(snapshot.deadlineAt)) {
      return refuseNow(ERROR_CODES.DEADLINE_EXCEEDED, "回答期限を過ぎています。");
    }

    // 手順2（外）：正式版参照を指定して読む。D08：対象日の版だけでなく、月内入力の
    // 完全性まで取る。欠けた日を0と推定しない（Q06／A09）。
    assertOutsideTransaction("勤務表の読込み");
    let inputs: SelectionInputs;
    try {
      const loaded = await deps.gateway.loadSchedule({
        connectionId: snapshot.connectionId,
        scheduleId: snapshot.scheduleId,
        authoritative: ref,
      });
      inputs = {
        connectionId: snapshot.connectionId,
        scheduleId: snapshot.scheduleId,
        sourceRevision: loaded.sourceRevision,
        baseArtifactRef: ref.artifactRef,
        monthlyCompleteness: loaded.completeness,
        missingDates: loaded.missingDates,
      };
    } catch (error) {
      // 読込みは外部作用ではない。未実装・未設定も、それ以外も、勤務表を確定できて
      // いないという点で同じ——ここでは何も作っていないので確定した拒否にしてよい。
      const code = isRefusedBeforeEffect(error) ? error.code : ERROR_CODES.INVALID_INPUT;
      return refuseNow(code, error instanceof Error ? error.message : "勤務表を読めません。");
    }

    // 選定固定（取引A）
    return withTransaction(async (tx): Promise<PrepareOutcome> => {
      const locked = await deps.cases.lockForUpdate(tx, command.caseId);
      if (locked === "NOT_FOUND" || locked.version !== snapshot.version) {
        return {
          kind: "FAILED",
          result: await refuse(
            deps.operations,
            tx,
            command.operationId,
            ERROR_CODES.REVISION_CONFLICT,
            "案件が並行して更新されました。読み直してください。",
          ),
        };
      }

      if (deps.loadMonthlyEligibility) {
        try {
          const monthly = await deps.loadMonthlyEligibility(tx, {
            storeId: locked.storeId,
            businessDate: locked.businessDate,
          });
          inputs = { ...inputs, monthlyRevision: monthly.monthlySchedule.sourceRevision };
        } catch (error) {
          return {
            kind: "FAILED",
            result: await refuse(
              deps.operations,
              tx,
              command.operationId,
              ERROR_CODES.INVALID_INPUT,
              error instanceof Error ? error.message : "月内入力を検査できません。",
            ),
          };
        }
      }

      const commitments = await deps.commitments.listByCase(tx, command.caseId);
      const supersededBy = new Map<string, string>();
      for (const c of commitments) {
        if (c.supersedes) supersededBy.set(c.supersedes, c.commitmentId);
      }
      const candidates: SelectionCandidate[] = [];
      for (const commitment of commitments) {
        const selectable = isSelectableCommitment({
          status: commitment.status,
          supersededBy: supersededBy.get(commitment.commitmentId),
          hasUnprocessedReply: await deps.inbound.hasUnprocessed(tx, commitment.outreachId),
          deadlineAt: locked.deadlineAt,
          now,
        });
        if (!selectable.selectable) continue;
        candidates.push({
          commitmentId: commitment.commitmentId,
          commitmentVersion: commitment.version,
          staffId: commitment.staffId,
          startAt: toJstTimestamp(commitment.startAt),
          endAt: toJstTimestamp(commitment.endAt),
          // 同率のときの安定した順序。時刻ではなく受信順を使う（RFC-011 §4）。
          committedSeq: commitment.sourceReceivedSeq,
          // 採用時に作る勤務ID。選定の時点で確定させ、再試行で採番し直さない
          // （RFC-010 §3、D05）。
          plannedShiftAssignmentId: deps.ids.next(),
        });
      }

      let planned;
      try {
        planned = deps.planner.plan({
          caseId: locked.caseId,
          caseVersion: locked.version,
          requirement: {
            roleCode: locked.roleCode,
            startAt: toJstTimestamp(locked.requiredStartAt),
            endAt: toJstTimestamp(locked.requiredEndAt),
          },
          candidates,
          inputs,
        });
      } catch (error) {
        const code = error instanceof TaskcalError ? error.code : ERROR_CODES.INVALID_INPUT;
        return {
          kind: "FAILED",
          result: await refuse(
            deps.operations,
            tx,
            command.operationId,
            code,
            error instanceof Error ? error.message : "選定できません。",
          ),
        };
      }

      const selection: SelectionResult = {
        ...planned,
        selectionId: deps.ids.next(),
        decidedAt: now,
      };
      // 承諾0件の評価でも残す。なぜ選べなかったかを後から説明できるように（RFC-009 §4）。
      await deps.selections.save(tx, selection);

      if (selection.outcome !== "FEASIBLE" || selection.selected.length === 0) {
        // A16：この組合せの不成立だけで案件を終了しない。調整中のまま据え置く。
        const reason = selection.notFeasibleReason ?? "NO_COMMITMENTS";
        await deps.cases.recordEvent(tx, {
          caseId: command.caseId,
          kind: "SELECTION_NOT_FEASIBLE",
          detail: { selectionId: selection.selectionId, reason },
        });
        const stored = {
          outcome: "NOT_FEASIBLE" as const,
          selectionId: selection.selectionId,
          reason,
        };
        await deps.operations.complete(tx, {
          operationId: command.operationId,
          status: "SUCCEEDED",
          result: stored,
        });
        return { kind: "NOT_FEASIBLE", result: { ok: true, ...stored, replayed: false } };
      }

      const additions = plannedAdditions(selection, locked);
      const absences = plannedAbsences(locked);
      const payload: ApplyUpdatePayloadForHash = {
        connectionId: locked.connectionId,
        scheduleId: locked.scheduleId,
        expectedSourceRevision: inputs.sourceRevision,
        baseArtifactRef: inputs.baseArtifactRef,
        additions,
        absences,
      };
      const requestHash = computeRequestHash(payload);

      // 外部作用の冪等キーを先に登録する。schedule_update がこの行を参照する。
      const begun = await deps.operations.begin(tx, {
        operation: { operationId: applyOperationId(selection.selectionId), requestHash },
        kind: "APPLY_UPDATE",
        connectionId: locked.connectionId,
        caseId: locked.caseId,
      });
      if (begun.match === "CONFLICT") {
        return {
          kind: "FAILED",
          result: await refuse(
            deps.operations,
            tx,
            command.operationId,
            ERROR_CODES.OPERATION_CONFLICT,
            "同じ選定IDで内容が異なります。",
          ),
        };
      }

      const moved = await deps.cases.applyTransition(tx, {
        caseId: locked.caseId,
        expectedVersion: locked.version,
        to: "PREPARING",
      });
      if (moved === "VERSION_CONFLICT") {
        return {
          kind: "FAILED",
          result: await refuse(
            deps.operations,
            tx,
            command.operationId,
            ERROR_CODES.REVISION_CONFLICT,
            "案件が並行して更新されました。",
          ),
        };
      }

      const update = await deps.scheduleUpdates.create(tx, {
        scheduleUpdateId: deps.ids.next(),
        caseId: locked.caseId,
        // 準備開始の遷移で案件版が1つ進んだ。採用直前の再検査はこの版と照合する（D08）。
        caseVersion: locked.version + 1,
        selectionId: selection.selectionId,
        operationId: applyOperationId(selection.selectionId),
        connectionId: locked.connectionId,
        scheduleId: locked.scheduleId,
        expectedSourceRevision: inputs.sourceRevision,
      });

      return {
        kind: "PREPARED",
        update,
        selection,
        requestHash,
        baseArtifactRef: inputs.baseArtifactRef,
        additions,
        absences,
      };
    });
  }

  /** 手順3：外部作用。**取引の外で行う。再実行しない。** */
  async function applyToSource(input: {
    update: ScheduleUpdateSnapshot;
    requestHash: RequestHash;
    baseArtifactRef?: string;
    additions: readonly PlannedAssignment[];
    absences: readonly PlannedAbsence[];
  }): Promise<UpdateResult | { readonly unknown: true } | { readonly refused: TaskcalError }> {
    assertOutsideTransaction("勤務表の更新");
    try {
      return await deps.gateway.applyUpdate({
        operation: { operationId: input.update.operationId, requestHash: input.requestHash },
        connectionId: input.update.connectionId,
        scheduleId: input.update.scheduleId,
        expectedSourceRevision: input.update.expectedSourceRevision,
        baseArtifactRef: input.baseArtifactRef,
        additions: input.additions,
        absences: input.absences,
      });
    } catch (error) {
      if (isRefusedBeforeEffect(error)) return { refused: error };
      // 例外＝成否不明（RFC-010 §7）。確定失敗と断定せず、再実行もしない。
      return { unknown: true };
    }
  }

  /** 結果不明の照会（A03／D09）。照合できるまで未採用と断定しない。 */
  async function lookUp(
    update: ScheduleUpdateSnapshot,
    requestHash: RequestHash,
  ): Promise<UpdateResult | "UNRESOLVED"> {
    if (!deps.gateway.capabilities.supportsResultLookup) return "UNRESOLVED";
    assertOutsideTransaction("更新結果の照会");
    try {
      const found = await deps.gateway.getUpdateResult({
        operationId: update.operationId,
        connectionId: update.connectionId,
        expectedRequestHash: requestHash,
      });
      // `LOOKUP_UNAVAILABLE` も `CONFLICT` も「採用していないと確認できた」ではない。
      return typeof found === "string" ? "UNRESOLVED" : found;
    } catch {
      return "UNRESOLVED";
    }
  }

  /** 未採用と確認できた場合の確定。成果物は未採用として保持する。 */
  async function settleNotAdopted(input: {
    update: ScheduleUpdateSnapshot;
    operationId: string;
    code: ErrorCode;
    detail: string;
    resultKind?: UpdateResultKind;
    artifactRef?: string;
    revisionCheckEnforced?: boolean;
  }): Promise<Failure> {
    const finding = RECONCILE_FINDING.CONFIRMED_NOT_ADOPTED;
    await withTransaction(async (tx) => {
      await deps.scheduleUpdates.advance(tx, {
        scheduleUpdateId: input.update.scheduleUpdateId,
        to: resolveReconcile(finding),
        resultKind: input.resultKind,
        artifactRef: input.artifactRef,
        revisionCheckEnforced: input.revisionCheckEnforced,
      });
      const snapshot = await deps.cases.lockForUpdate(tx, input.update.caseId);
      if (snapshot !== "NOT_FOUND") {
        await moveCase(
          tx,
          snapshot,
          resolveCaseReconcile({
            finding,
            lookupStillPossible: deps.gateway.capabilities.supportsResultLookup,
          }),
          { adoptionFact: ADOPTION_FACT.NOT_ADOPTED },
        );
      }
      await deps.cases.recordEvent(tx, {
        caseId: input.update.caseId,
        kind: "ADOPT_NOT_APPLIED",
        detail: { scheduleUpdateId: input.update.scheduleUpdateId, code: input.code },
      });
      await refuse(deps.operations, tx, input.operationId, input.code, input.detail);
    });
    return fail(input.code, input.detail, "REJECTED");
  }

  /** 結果不明を記録する。**未採用と断定しない**（A03／ADR-022）。 */
  async function markReconcileRequired(input: {
    update: ScheduleUpdateSnapshot;
    operationId: string;
    detail: string;
  }): Promise<Failure> {
    const finding = RECONCILE_FINDING.STILL_UNKNOWN;
    await withTransaction(async (tx) => {
      const snapshot = await deps.cases.lockForUpdate(tx, input.update.caseId);
      // **案件を先に動かし、その版を更新へ書き戻す。** `RECONCILE_REQUIRED` は終端では
      // ないので、ここで版がずれたまま残すと、次の再開が「別の変更が入った」と誤判定して
      // 採用できたはずの計画を未採用と断定する（A03／D08）。
      let caseVersion: number | undefined;
      if (snapshot !== "NOT_FOUND") {
        const moved = await moveCase(
          tx,
          snapshot,
          resolveCaseReconcile({
            finding,
            lookupStillPossible: deps.gateway.capabilities.supportsResultLookup,
          }),
          // 未採用へ丸めない。確認できるまで成否不明のまま持つ。
          { adoptionFact: ADOPTION_FACT.UNKNOWN },
        );
        caseVersion = moved.moved ? moved.version : snapshot.version;
      }
      await deps.scheduleUpdates.advance(tx, {
        scheduleUpdateId: input.update.scheduleUpdateId,
        to: resolveReconcile(finding),
        resultKind: "UNKNOWN",
        caseVersion,
      });
      await deps.cases.recordEvent(tx, {
        caseId: input.update.caseId,
        kind: "ADOPT_RECONCILE_REQUIRED",
        detail: { scheduleUpdateId: input.update.scheduleUpdateId },
      });
      // 操作は UNKNOWN。REFUSED（確定した拒否）と同じ欄に畳まない。
      await deps.operations.complete(tx, {
        operationId: input.operationId,
        status: "UNKNOWN",
        result: { outcome: "RECONCILE_REQUIRED", detail: input.detail },
      });
    });
    return fail(ERROR_CODES.RECONCILE_REQUIRED, input.detail, "RECONCILE_REQUIRED");
  }

  return async function run(command: AdoptPlanCommand): Promise<AdoptPlanResult> {
    // 操作IDが描画ごとに一意なので、D07の内容照合はここでは実質働かない（同じIDが
    // 再び来るのは同じ描画からの二重クリックだけで、そのとき内容は必ず同じ）。
    // 内容の照合が効くのは外部作用の側（`apply:{selectionId}`）。
    const requestHash = computeRequestHash({ caseId: command.caseId });

    const begun = await withTransaction((tx) =>
      deps.operations.begin(tx, {
        operation: { operationId: command.operationId, requestHash },
        kind: "ADOPT_PLAN",
        caseId: command.caseId,
      }),
    );
    if (begun.match === "CONFLICT") {
      return fail(ERROR_CODES.OPERATION_CONFLICT, "同じ操作IDで内容が異なります。");
    }
    if (begun.match === "REPLAY") {
      const stored = begun.stored;
      if (stored?.status === "REFUSED") {
        const detail = stored.result as { code?: ErrorCode; detail?: string } | undefined;
        return fail(
          detail?.code ?? ERROR_CODES.INVALID_INPUT,
          detail?.detail ?? "同じ操作は前回拒否しています。",
        );
      }
      if (stored?.status === "SUCCEEDED") {
        const result = stored.result as {
          outcome?: string;
          scheduleUpdateId?: string;
          adopted?: number;
          selectionId?: string;
          reason?: string;
        } | null;
        if (result?.outcome === "ADOPTED" && result.scheduleUpdateId) {
          // **照合結果を true で固定しない。** 手順7は別取引なので、採用済みでも
          // 読戻しが一致していない（`ATTENTION`）ことがある。再表示のときだけ
          // 要対応を黙らせると、A07／D09 が画面から消える。
          const current = await withTransaction((tx) => deps.cases.findById(tx, command.caseId));
          return {
            ok: true,
            outcome: "ADOPTED",
            scheduleUpdateId: result.scheduleUpdateId,
            adopted: result.adopted ?? 0,
            readBackMatches:
              current !== "NOT_FOUND" &&
              (current.state === "REPORTING" || current.state === "COMPLETED"),
            replayed: true,
          };
        }
        if (result?.outcome === "NOT_FEASIBLE" && result.selectionId) {
          return {
            ok: true,
            outcome: "NOT_FEASIBLE",
            selectionId: result.selectionId,
            reason: result.reason ?? "NO_COMMITMENTS",
            replayed: true,
          };
        }
      }
      if (stored?.status === "IN_PROGRESS") {
        // **同じ操作を二重に走らせない。** 操作IDは描画ごとに作るので、同じIDが
        // 再び来るのは同一描画からの二重クリックだけ。ここで再開経路へ落とすと、
        // 1本目が `applyUpdate` を待っている間に2本目が照会して未解決を得て、
        // 案件と更新を照合待ちへ落とす。戻ってきた1本目は版競合で成果物を捨てる。
        //
        // プロセスが落ちた後の再開は**別の操作ID**で来る（描画し直すため）ので、
        // ここで断っても復旧経路は塞がらない。
        return fail(
          ERROR_CODES.RECONCILE_REQUIRED,
          "同じ操作が進行中です。結果を確認してから再実行してください。",
        );
      }
      // UNKNOWN（結果不明として閉じた操作）は作り直さない。下の再開経路で照合する。
    }

    // 進行中の更新があれば、作り直さずそこから再開する（RFC-010 §7）。
    const open = await withTransaction((tx) =>
      deps.scheduleUpdates.findOpenByCase(tx, command.caseId),
    );

    let update: ScheduleUpdateSnapshot;
    let selection: SelectionResult;
    let applyHash: RequestHash;
    let baseArtifactRef: string | undefined;
    let additions: readonly PlannedAssignment[];
    let absences: readonly PlannedAbsence[];

    // **この呼出しで作った更新**と、DBから拾った更新を区別する。拾った更新は、
    // 前回の呼出しが `applyUpdate` の途中で落ちていたかもしれない。確かめずに
    // もう一度送ると外部作用が二度起きる（A03／RFC-010 §7）。
    const resuming = open !== "NONE";

    if (open === "NONE") {
      const prepared = await prepare(command);
      if (prepared.kind !== "PREPARED") return prepared.result;
      ({
        update,
        selection,
        requestHash: applyHash,
        baseArtifactRef,
        additions,
        absences,
      } = prepared);
    } else {
      update = open;
      const resumed = await withTransaction(async (tx) => {
        const stored = await deps.selections.findById(tx, open.selectionId);
        const snapshot = await deps.cases.findById(tx, command.caseId);
        return { stored, snapshot };
      });
      if (resumed.stored === "NOT_FOUND" || resumed.snapshot === "NOT_FOUND") {
        return fail(ERROR_CODES.INVALID_INPUT, "再開に必要な選定結果または案件がありません。");
      }
      selection = resumed.stored;
      baseArtifactRef = selection.inputs.baseArtifactRef;
      additions = plannedAdditions(selection, resumed.snapshot);
      absences = plannedAbsences(resumed.snapshot);
      applyHash = computeRequestHash({
        connectionId: update.connectionId,
        scheduleId: update.scheduleId,
        expectedSourceRevision: update.expectedSourceRevision,
        baseArtifactRef,
        additions,
        absences,
      } satisfies ApplyUpdatePayloadForHash);

      // D07：再開で作り直した内容が、前回と同じであることを確かめる。案件や承諾が
      // 動いていれば、同じ冪等キーのまま**内容の違う**要求になる。ここで気付かないと、
      // 外部から見て同じ操作なのに中身が入れ替わる。
      const again = await withTransaction((tx) =>
        deps.operations.begin(tx, {
          operation: { operationId: update.operationId, requestHash: applyHash },
          kind: "APPLY_UPDATE",
          connectionId: update.connectionId,
          caseId: command.caseId,
        }),
      );
      if (again.match === "CONFLICT") {
        // 前回と内容が違う。外部作用の成否は分からないので、未採用と断定しない。
        return markReconcileRequired({
          update,
          operationId: command.operationId,
          detail: "再開時の更新内容が前回と一致しません。照合するまで採用しません。",
        });
      }
    }

    // --- 手順3-4：外部作用と読戻し ---
    let artifactRef = update.artifactRef;
    let newSourceRevision = update.newSourceRevision;

    if (update.state !== "PREPARED") {
      let outcome: UpdateResult | "UNRESOLVED";
      if (resuming) {
        // **再実行しない。** 前回の呼出しが途中で落ちていれば外部作用は済んでいる
        // かもしれない。「未実行の確認」ができるのは照会だけで、それができない
        // うちは成否不明として人の対応を待つ（A03／RFC-010 §7）。
        outcome = await lookUp(update, applyHash);
      } else {
        const applied = await applyToSource({
          update,
          requestHash: applyHash,
          baseArtifactRef,
          additions,
          absences,
        });
        if ("refused" in applied) {
          // adapter が外部作用の前に断った。未採用と確定している。
          return settleNotAdopted({
            update,
            operationId: command.operationId,
            code: applied.refused.code,
            detail: applied.refused.message,
            resultKind: "NOT_APPLIED",
          });
        }
        outcome = "unknown" in applied ? "UNRESOLVED" : applied;
      }

      if (outcome === "UNRESOLVED" || isOutcomeUnknown(outcome.kind)) {
        // 外部作用の操作も結果不明として閉じる。IN_PROGRESS のまま残すと、
        // 「まだ始めていない」と「結果が分からない」を操作表で区別できない。
        await withTransaction((tx) =>
          deps.operations.complete(tx, {
            operationId: update.operationId,
            status: "UNKNOWN",
            result: { kind: outcome === "UNRESOLVED" ? "UNRESOLVED" : outcome.kind },
          }),
        );
        return markReconcileRequired({
          update,
          operationId: command.operationId,
          detail: "勤務表の更新結果を照合できません。再実行せず、人の対応を待ちます。",
        });
      }
      if (outcome.kind === "EXPORTED_ONLY") {
        // RFC-010 §7 / A14：出力のみモード。**元原本には反映されていない。**
        // 成果物はできているので保持するが、正式採用はしない。ここで止めないと、
        // 反映していない出力を内部勤務・正式版参照ごと「確定」にしてしまう。
        await withTransaction((tx) =>
          deps.operations.complete(tx, {
            operationId: update.operationId,
            status: "SUCCEEDED",
            result: { kind: outcome.kind, artifactRef: outcome.artifactRef },
          }),
        );
        return settleNotAdopted({
          update,
          operationId: command.operationId,
          code: ERROR_CODES.OUT_OF_SCOPE,
          detail:
            "出力のみモードの成果物です。元原本へ反映されていないため正式採用しません（A14）。",
          resultKind: outcome.kind,
          artifactRef: outcome.artifactRef,
          revisionCheckEnforced: outcome.revisionCheckEnforced,
        });
      }
      if (outcome.kind === "NOT_APPLIED" || outcome.kind === "CONFLICT") {
        await withTransaction((tx) =>
          deps.operations.complete(tx, {
            operationId: update.operationId,
            status: "REFUSED",
            result: { kind: outcome.kind },
          }),
        );
        return settleNotAdopted({
          update,
          operationId: command.operationId,
          code: ERROR_CODES.REVISION_CONFLICT,
          detail:
            outcome.kind === "CONFLICT"
              ? "勤務表の期待版と一致しません。"
              : "勤務表へ反映されませんでした。",
          resultKind: outcome.kind,
          revisionCheckEnforced: outcome.revisionCheckEnforced,
        });
      }

      artifactRef = outcome.artifactRef ?? artifactRef;
      newSourceRevision = outcome.newSourceRevision ?? newSourceRevision;
      if (!artifactRef) {
        return markReconcileRequired({
          update,
          operationId: command.operationId,
          detail: "成果物の参照が返りませんでした。照合するまで採用しません。",
        });
      }

      // 手順4：書込み完了した成果物を読み戻して検査する。
      assertOutsideTransaction("成果物の読戻し");
      let matched: boolean;
      try {
        const back = await deps.gateway.readBack({
          connectionId: update.connectionId,
          artifactRef,
        });
        matched = matchesExpected(back.assignments, additions, absences, update.caseId);
        newSourceRevision = back.sourceRevision;
      } catch {
        return markReconcileRequired({
          update,
          operationId: command.operationId,
          detail: "成果物を読み戻せません。照合するまで採用しません。",
        });
      }
      if (!matched) {
        // A07：反映確認に失敗した成果物を採用しない。完了にもしない。
        return settleNotAdopted({
          update,
          operationId: command.operationId,
          code: ERROR_CODES.INVALID_INPUT,
          detail: "読戻しが期待する内容と一致しません。採用しません。",
          resultKind: outcome.kind,
          artifactRef,
        });
      }

      // 検査済みの作業用成果物ができた。**まだ正式勤務ではない。**
      await withTransaction(async (tx) => {
        if (update.state === "PREPARING") {
          await deps.scheduleUpdates.advance(tx, {
            scheduleUpdateId: update.scheduleUpdateId,
            to: "PREPARED",
            resultKind: outcome.kind,
            artifactRef,
            newSourceRevision,
            revisionCheckEnforced: outcome.revisionCheckEnforced,
          });
        }
        await deps.operations.complete(tx, {
          operationId: update.operationId,
          status: "SUCCEEDED",
          result: { kind: outcome.kind, artifactRef },
        });
      });
      update = { ...update, state: "PREPARED", artifactRef, newSourceRevision };
    } else if (resuming) {
      // RFC-010 §7「CSV保存後・正式採用前の停止：操作IDで**成果物を照合し**、前提を
      // 再検査して採用または破棄」。前提（手順5）は採用取引で見るが、成果物そのものは
      // ここで見る。前回検査した後にファイルが変わっている可能性を消さない。
      if (!artifactRef) {
        return markReconcileRequired({
          update,
          operationId: command.operationId,
          detail: "検査済みの成果物の参照がありません。照合するまで採用しません。",
        });
      }
      assertOutsideTransaction("成果物の読戻し");
      try {
        const back = await deps.gateway.readBack({
          connectionId: update.connectionId,
          artifactRef,
        });
        if (!matchesExpected(back.assignments, additions, absences, update.caseId)) {
          return settleNotAdopted({
            update,
            operationId: command.operationId,
            code: ERROR_CODES.INVALID_INPUT,
            detail: "検査済みの成果物が期待する内容と一致しません。採用しません。",
            artifactRef,
          });
        }
        newSourceRevision = back.sourceRevision;
      } catch {
        return markReconcileRequired({
          update,
          operationId: command.operationId,
          detail: "成果物を読み戻せません。照合するまで採用しません。",
        });
      }
    }

    // 成果物と新しい版が無いまま正式版参照を差し替えない。旧版のまま採用済みに
    // 書き換えると、勤務だけ増えて成果物は古いままになる。
    if (!artifactRef || !newSourceRevision) {
      return markReconcileRequired({
        update,
        operationId: command.operationId,
        detail: "成果物または新しい版が確定していません。採用しません。",
      });
    }

    // --- 手順5の前段：月内入力を**取り直して**照合する（D08） ---
    // 選定時に固定した `inputs` をそのまま再検査に使わない。それは「検査した時点の
    // 値」で、その後に別営業日の勤務やスタッフ条件が変わっても気付けない。
    // RFC-010 §4 手順5 は「参照した入力版」を再検査せよと言っている。
    assertOutsideTransaction("月内入力の再取得");
    // 取り直した値は直前再検査（Q15）でも使う。ここで捨てると、選定時に固定した
    // 値で検査することになり、D08 の意味が無くなる。
    let reloaded: LoadedSchedule;
    try {
      reloaded = await deps.gateway.loadSchedule({
        connectionId: update.connectionId,
        scheduleId: update.scheduleId,
        authoritative: await withTransaction(async (tx) => {
          const ref = await deps.authoritative.get(tx, {
            connectionId: update.connectionId,
            scheduleId: update.scheduleId,
          });
          return ref === "NOT_FOUND" ? undefined : ref;
        }),
      });
      if (reloaded.sourceRevision !== selection.inputs.sourceRevision) {
        return settleNotAdopted({
          update,
          operationId: command.operationId,
          code: ERROR_CODES.REVISION_CONFLICT,
          detail: "選定してから勤務表の版が変わっています。採用しません。",
          artifactRef,
        });
      }
      if (reloaded.completeness !== "COMPLETE") {
        // Q06／A09：欠けた日を0と推定しない。完全でなければ月次上限を検査できない。
        return settleNotAdopted({
          update,
          operationId: command.operationId,
          code: ERROR_CODES.INVALID_INPUT,
          detail: `月内入力が完全ではありません（${reloaded.completeness}）。採用しません。`,
          artifactRef,
        });
      }
    } catch (error) {
      if (isRefusedBeforeEffect(error)) {
        return settleNotAdopted({
          update,
          operationId: command.operationId,
          code: error.code,
          detail: error.message,
          artifactRef,
        });
      }
      // 読めないだけで未採用と断定しない。採用はまだしていないが、前提を
      // 確かめられていないので照合待ちへ回す。
      return markReconcileRequired({
        update,
        operationId: command.operationId,
        detail: "採用の直前に月内入力を取り直せません。前提を確かめるまで採用しません。",
      });
    }

    // --- 手順5-6：直前再検査と一括保存 ---
    const adopted = await adopt({
      update: { ...update, artifactRef, newSourceRevision },
      selection,
      operationId: command.operationId,
      reloaded,
    });
    if ("rolledBack" in adopted) {
      const { code, message, alreadyAdopted } = adopted.rolledBack;
      if (alreadyAdopted) {
        // A04：別の実行がすでに採用している。**未採用として上書きしない。**
        // 自分の操作だけを拒否として閉じ、相手の確定事実へは触れない。
        await withTransaction((tx) =>
          refuse(deps.operations, tx, command.operationId, code, message),
        );
        return fail(code, message);
      }
      // 取引は巻き戻り、勤務は1件も残っていない（A08）。**未採用と確定して構わない。**
      // ここで確定させないと、更新が PREPARED・操作が IN_PROGRESS のまま残り、
      // 決定的な失敗（重複・重なり）なら再試行が同じ場所で無限に止まる。
      return settleNotAdopted({
        update,
        operationId: command.operationId,
        code,
        detail: message,
      });
    }
    if (!adopted.ok) return adopted;

    // --- 手順7：正式版を再取得して整合を確認する（RFC-010 §4 手順7、D11／A01） ---
    const snapshot = await withTransaction((tx) => deps.cases.findById(tx, command.caseId));
    let matches = false;
    if (snapshot !== "NOT_FOUND") {
      // 内部の勤務表。正式版参照を経由して読む（D11）。
      const loaded = await withTransaction((tx) =>
        deps.schedules.loadByDate(tx, {
          connectionId: snapshot.connectionId,
          storeId: snapshot.storeId,
          businessDate: snapshot.businessDate,
        }),
      );
      const internalMatches =
        loaded !== "NOT_ADOPTED" &&
        matchesExpected(loaded.assignments, additions, absences, snapshot.caseId);

      // **成果物も読み直す。** 内部表だけでは、採用取引で自分が書いた行を読み返して
      // いるだけで、読戻しの後にCSVが消失・破損・改変されても一致扱いになる。
      assertOutsideTransaction("正式版の再取得");
      const artifact = await verifyAdoptedArtifact({
        gateway: deps.gateway,
        connectionId: update.connectionId,
        artifactRef,
        additions,
        absences,
        caseId: snapshot.caseId,
      });
      matches = internalMatches && artifact.matches;

      await withTransaction(async (tx) => {
        const current = await deps.cases.lockForUpdate(tx, command.caseId);
        if (current === "NOT_FOUND" || current.state !== "COMMITTED") return;
        // D09：一致しなくても確定済みの勤務と採用事実は消さない。要対応にする。
        await deps.cases.applyTransition(tx, {
          caseId: current.caseId,
          expectedVersion: current.version,
          to: matches ? "REPORTING" : "ATTENTION",
        });
        await deps.cases.recordEvent(tx, {
          caseId: current.caseId,
          kind: matches ? "ADOPTION_VERIFIED" : "ADOPTION_READBACK_MISMATCH",
          // どちらが合わなかったかを残す。内部表と成果物で対処が違う。
          detail: matches ? undefined : { internal: internalMatches, artifact: artifact.reason },
        });
      });
    }

    return {
      ok: true,
      outcome: "ADOPTED",
      scheduleUpdateId: update.scheduleUpdateId,
      adopted: adopted.adopted,
      readBackMatches: matches,
      replayed: false,
    };
  };
}
