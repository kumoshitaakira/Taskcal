/**
 * 止まった案件を照合して前へ進める（workerの1ステップ）。
 *
 * Q11・Q12・Q13／ADR-022 で足した三つの経路の実行側。RFC-012 §5 の A03・A13・A18。
 *
 *   - `RECONCILE_REQUIRED` … 採用の成否を照会する。確定できなければ `ATTENTION`（Q11）
 *   - `ATTENTION` … 成果物を読み直し、**採用済みかつ読戻し一致のときだけ** `REPORTING`（Q12）
 *   - `PREPARING` ＋停止印 … 停止を保留した案件の決着（Q13）。`stop-case.ts` の受け皿
 *
 * 取引の分け方は `send-outbox.ts` と同じ三つ。`settle-reporting.ts` は全体を1取引で
 * 回しているが、ここは外部照会を含むため取引の外へ出す（RFC-010 §5：外部待ちの間
 * ロックを保持しない）。
 *
 * **未採用と断定しない。** 照会できない・照会経路が無いことを「採用していない」と
 * 読み替えると、実際には反映済みの計画があるまま別の計画を採用する（D05／A03）。
 *
 * **自動で終端へ落とさない。** 戻せない `ATTENTION` はそのまま残す。`HANDED_OFF` は
 * 人が引き取ったときの記録であり、復旧できなかったことの言い換えではない（ADR-022）。
 *
 * 取り出しは1巡回1件で、作成順。MVPは同時1案件なので、戻らない `ATTENTION` が他を
 * 塞ぐ問題は起きない。複数案件を同時に扱うなら、ここに待ち時間の仕組みが要る。
 */

import "server-only";
import { assertOutsideTransaction, withTransaction, type Tx } from "../adapters/db/transaction";
import type { ScheduleReadRepository } from "../adapters/db/schedule-repository";
import {
  canResumeReporting,
  resolveCaseReconcile,
  resolvePreparingStop,
  resolveReconcileStall,
  handoffReasonOf,
  ADOPTION_FACT,
  STOP_CAUSE,
  type AdoptionFact,
  type CaseState,
} from "../contracts/case-state";
import { ERROR_CODES, TaskcalError } from "../contracts/errors";
import {
  isOutcomeUnknown,
  RECONCILE_FINDING,
  resolveReconcile,
  type ReconcileFinding,
} from "../contracts/schedule-update";
import type { ScheduleGateway, UpdateResult } from "../contracts/schedule-gateway";
import type {
  AbsenceCaseRepository,
  AuthoritativeScheduleRefRepository,
  CaseSnapshot,
  Clock,
  ScheduleUpdateRepository,
  ScheduleUpdateSnapshot,
  SelectionResultRepository,
} from "../contracts/repository";
import { plannedAbsences, plannedAdditions, verifyAdoptedArtifact } from "./adoption-check";

export type RecoverCaseOutcome =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly caseId: string;
      /**
       * `WAITING` は「動かせる事実が無かった」。失敗ではない。並行更新で版がずれた
       * 場合も含む。次の巡回でもう一度見る。
       */
      readonly to: CaseState | "WAITING";
    };

export interface RecoverCaseDeps {
  readonly cases: AbsenceCaseRepository;
  readonly scheduleUpdates: ScheduleUpdateRepository;
  readonly selections: SelectionResultRepository;
  readonly schedules: ScheduleReadRepository;
  readonly authoritative: AuthoritativeScheduleRefRepository;
  readonly gateway: Pick<ScheduleGateway, "capabilities" | "getUpdateResult" | "readBack">;
  readonly clock: Clock;
}

/** 照会の結果から採用事実へ。`lookupStillPossible` は別に返す——断定と可否は別。 */
interface Finding {
  readonly finding: ReconcileFinding;
  readonly lookupStillPossible: boolean;
  readonly detail: string;
}

function adoptionFactOf(finding: ReconcileFinding): AdoptionFact {
  switch (finding) {
    case RECONCILE_FINDING.CONFIRMED_ADOPTED:
      return ADOPTION_FACT.ADOPTED;
    case RECONCILE_FINDING.CONFIRMED_NOT_ADOPTED:
      return ADOPTION_FACT.NOT_ADOPTED;
    case RECONCILE_FINDING.STILL_UNKNOWN:
      // 未採用へ丸めない。確認できるまで成否不明のまま持つ（ADR-022）。
      return ADOPTION_FACT.UNKNOWN;
  }
}

export function recoverCase(deps: RecoverCaseDeps) {
  /**
   * 外部照会（A03／D09）。`adopt-plan.ts` の `lookUp` と同じ規則。
   *
   * `LOOKUP_UNAVAILABLE` も `CONFLICT` も「採用していないと確認できた」ではない。
   */
  async function lookUp(update: ScheduleUpdateSnapshot): Promise<UpdateResult | "UNRESOLVED"> {
    if (!deps.gateway.capabilities.supportsResultLookup) return "UNRESOLVED";
    assertOutsideTransaction("更新結果の照会");
    try {
      const found = await deps.gateway.getUpdateResult({
        operationId: update.operationId,
        connectionId: update.connectionId,
      });
      return typeof found === "string" ? "UNRESOLVED" : found;
    } catch {
      return "UNRESOLVED";
    }
  }

  function findingOf(outcome: UpdateResult | "UNRESOLVED"): Finding {
    const lookupStillPossible = deps.gateway.capabilities.supportsResultLookup;
    if (outcome === "UNRESOLVED") {
      return {
        finding: RECONCILE_FINDING.STILL_UNKNOWN,
        lookupStillPossible,
        detail: "照会できません。",
      };
    }
    if (isOutcomeUnknown(outcome.kind)) {
      return {
        finding: RECONCILE_FINDING.STILL_UNKNOWN,
        lookupStillPossible,
        detail: `照会は ${outcome.kind} を返しました。`,
      };
    }
    if (outcome.kind === "APPLIED") {
      // 元原本は変わっているのに、こちら側の正式採用は済んでいない。自動では
      // 決着させない。「未採用」と言うと同じ計画をもう一度適用しかねず、
      // 「採用済み」と言うと存在しない勤務を確定済みとして表示する。
      return {
        finding: RECONCILE_FINDING.STILL_UNKNOWN,
        lookupStillPossible: false,
        detail: "元原本へ反映済みですが、正式採用の記録がありません。",
      };
    }
    // PREPARED / NOT_APPLIED / CONFLICT / EXPORTED_ONLY。
    // 成果物ができていても正式採用ではない（A02：未採用CSVを勤務として数えない）。
    return {
      finding: RECONCILE_FINDING.CONFIRMED_NOT_ADOPTED,
      lookupStillPossible,
      detail: `照会は ${outcome.kind} を返しました。正式採用は成立していません。`,
    };
  }

  /** `ATTENTION` から通知処理へ戻せるか（Q12）。戻せないときは何も動かさない。 */
  async function tryResumeReporting(caseId: string): Promise<RecoverCaseOutcome> {
    const prepared = await withTransaction(async (tx) => {
      const snapshot = await deps.cases.findById(tx, caseId);
      if (snapshot === "NOT_FOUND") return undefined;
      const ref = await deps.authoritative.get(tx, {
        connectionId: snapshot.connectionId,
        scheduleId: snapshot.scheduleId,
      });
      const scheduleUpdateId = ref === "NOT_FOUND" ? undefined : ref.adoptedByScheduleUpdateId;
      if (!scheduleUpdateId) return { snapshot, artifactRef: undefined };
      const stored = await deps.scheduleUpdates.findById(tx, scheduleUpdateId);
      if (stored === "NOT_FOUND") return { snapshot, artifactRef: undefined };
      const selection = await deps.selections.findById(tx, stored.selectionId);
      if (selection === "NOT_FOUND") return { snapshot, artifactRef: undefined };
      return {
        snapshot,
        artifactRef: stored.artifactRef,
        additions: plannedAdditions(selection, snapshot),
        absences: plannedAbsences(snapshot),
      };
    });
    if (!prepared) return { handled: false };

    const { snapshot, artifactRef } = prepared;

    // 読戻しは外部作用。取引の外で行う。
    const artifact = artifactRef
      ? await (async () => {
          assertOutsideTransaction("成果物の読戻し");
          return verifyAdoptedArtifact({
            gateway: deps.gateway,
            connectionId: snapshot.connectionId,
            artifactRef,
            additions: prepared.additions ?? [],
            absences: prepared.absences ?? [],
            caseId: snapshot.caseId,
          });
        })()
      : { matches: false as const, reason: "UNREADABLE" as const };

    // **Q12：採用済みと確認でき、かつ読戻しが一致した場合だけ戻す。**
    // 読戻しが未確認のまま通知処理へ進まない。
    const resumable = canResumeReporting({
      adoptionFact: snapshot.adoptionFact,
      readBackMatches: artifact.matches,
    });

    return withTransaction(async (tx) => {
      const locked = await deps.cases.lockForUpdate(tx, snapshot.caseId);
      if (locked === "NOT_FOUND") return { handled: false as const };
      if (locked.version !== snapshot.version || locked.state !== "ATTENTION") {
        // 照会の間に誰かが動かした。古い判断で上書きしない。
        return { handled: true as const, caseId: snapshot.caseId, to: "WAITING" as const };
      }
      if (!resumable) {
        await deps.cases.recordEvent(tx, {
          caseId: snapshot.caseId,
          kind: "RECOVER_NOT_RESUMABLE",
          detail: { adoptionFact: locked.adoptionFact, artifact: artifact.reason ?? "MATCHES" },
        });
        // **終端へ落とさない。** 人が引き取るまで `ATTENTION` のまま残す。
        return { handled: true as const, caseId: snapshot.caseId, to: "WAITING" as const };
      }
      const moved = await deps.cases.applyTransition(tx, {
        caseId: snapshot.caseId,
        expectedVersion: locked.version,
        to: "REPORTING",
      });
      if (moved === "VERSION_CONFLICT") {
        return { handled: true as const, caseId: snapshot.caseId, to: "WAITING" as const };
      }
      await deps.cases.recordEvent(tx, { caseId: snapshot.caseId, kind: "REPORTING_RESUMED" });
      return { handled: true as const, caseId: snapshot.caseId, to: "REPORTING" as const };
    });
  }

  /** 採用の成否を照合して決着させる。`RECONCILE_REQUIRED` と停止保留の共通経路。 */
  async function reconcileAdoption(caseId: string): Promise<RecoverCaseOutcome> {
    const prepared = await withTransaction(async (tx) => {
      const snapshot = await deps.cases.findById(tx, caseId);
      if (snapshot === "NOT_FOUND") return undefined;
      const open = await deps.scheduleUpdates.findOpenByCase(tx, caseId);
      // 未決の更新が無くても、**正式版参照を見てから**でなければ未採用と言えない。
      // 採用済みの更新は終端なので `findOpenByCase` では引けない（D11：参照から始める）。
      const ref = await deps.authoritative.get(tx, {
        connectionId: snapshot.connectionId,
        scheduleId: snapshot.scheduleId,
      });
      const adoptedId = ref === "NOT_FOUND" ? undefined : ref.adoptedByScheduleUpdateId;
      if (open === "NONE") {
        const adoptedHere = adoptedId
          ? await deps.scheduleUpdates.findById(tx, adoptedId)
          : "NOT_FOUND";
        const belongs = adoptedHere !== "NOT_FOUND" && adoptedHere.caseId === caseId;
        return { snapshot, update: undefined, adopted: belongs };
      }
      return { snapshot, update: open, adopted: adoptedId === open.scheduleUpdateId };
    });
    if (!prepared) return { handled: false };
    const { snapshot, update } = prepared;

    if (!update) {
      // 未決の更新が無い。正式版参照がこの案件の採用を指していれば採用済み。
      return settle(
        snapshot,
        undefined,
        prepared.adopted
          ? {
              finding: RECONCILE_FINDING.CONFIRMED_ADOPTED,
              lookupStillPossible: true,
              detail: "正式版参照がこの案件の採用を指しています。",
            }
          : {
              finding: RECONCILE_FINDING.CONFIRMED_NOT_ADOPTED,
              lookupStillPossible: deps.gateway.capabilities.supportsResultLookup,
              detail: "未決の勤務表更新が無く、正式版参照も採用を指していません。",
            },
      );
    }

    const found: Finding = prepared.adopted
      ? {
          finding: RECONCILE_FINDING.CONFIRMED_ADOPTED,
          lookupStillPossible: true,
          detail: "正式版参照がこの更新を採用元として指しています。",
        }
      : findingOf(await lookUp(update));

    return settle(snapshot, update, found);
  }

  /** 照合結果から、更新と案件の**両方**を決める（ADR-022）。 */
  async function settle(
    snapshot: CaseSnapshot,
    update: ScheduleUpdateSnapshot | undefined,
    found: Finding,
  ): Promise<RecoverCaseOutcome> {
    const now = deps.clock.now();
    return withTransaction(async (tx) => {
      const locked = await deps.cases.lockForUpdate(tx, snapshot.caseId);
      if (locked === "NOT_FOUND") return { handled: false as const };
      if (locked.version !== snapshot.version || locked.state !== snapshot.state) {
        return { handled: true as const, caseId: snapshot.caseId, to: "WAITING" as const };
      }

      const adoptionFact = adoptionFactOf(found.finding);

      // 停止を保留した案件（Q13）と、照合待ちの案件（Q11）で、案件側の行き先だけが違う。
      // 更新側は同じ `resolveReconcile` を通す——同じ照合結果から両方を決める。
      // `PREPARING` をここで拾うのは停止印がある案件だけ（取り出しの `where`）。
      // DBは `stop_cause` と `stopped_at` を対で要求するので、印があれば理由もある。
      const stopCause = locked.stopCause;
      if (locked.state === "PREPARING" && !stopCause) {
        throw new TaskcalError(
          ERROR_CODES.INVALID_INPUT,
          `案件 ${locked.caseId} に停止理由がありません。`,
        );
      }
      const to: CaseState =
        locked.state === "PREPARING" && stopCause
          ? resolvePreparingStop({ adoptionFact, cause: stopCause })
          : found.finding === RECONCILE_FINDING.STILL_UNKNOWN
            ? // Q11：照合が継続不能なら要対応へ。未採用とも採用済みとも断定しない。
              resolveReconcileStall({ lookupStillPossible: found.lookupStillPossible })
            : resolveCaseReconcile({
                finding: found.finding,
                lookupStillPossible: found.lookupStillPossible,
              });

      if (to === locked.state) {
        await deps.cases.recordEvent(tx, {
          caseId: snapshot.caseId,
          kind: "RECOVER_UNRESOLVED",
          detail: { finding: found.finding, detail: found.detail },
        });
        return { handled: true as const, caseId: snapshot.caseId, to: "WAITING" as const };
      }

      const moved = await deps.cases.applyTransition(tx, {
        caseId: snapshot.caseId,
        expectedVersion: locked.version,
        to,
        adoptionFact,
        ...(to === "HANDED_OFF"
          ? {
              handoff: {
                reason: handoffReasonOf(stopCause ?? STOP_CAUSE.DEADLINE),
                adoptionFact,
                handedOffAt: now,
              },
            }
          : {}),
      });
      if (moved === "VERSION_CONFLICT") {
        return { handled: true as const, caseId: snapshot.caseId, to: "WAITING" as const };
      }

      if (update) {
        // 案件を先に動かした版を書き戻す。ずれたまま残すと、次の再開が
        // 「別の変更が入った」と誤判定する（D08／A03）。
        await deps.scheduleUpdates.advance(tx, {
          scheduleUpdateId: update.scheduleUpdateId,
          to: resolveReconcile(found.finding),
          caseVersion: locked.version + 1,
          ...(found.finding === RECONCILE_FINDING.CONFIRMED_ADOPTED ? { adoptedAt: now } : {}),
        });
      }
      await deps.cases.recordEvent(tx, {
        caseId: snapshot.caseId,
        kind: "RECOVER_RECONCILED",
        detail: { finding: found.finding, to, detail: found.detail },
      });
      return { handled: true as const, caseId: snapshot.caseId, to };
    });
  }

  return async function runOnce(): Promise<RecoverCaseOutcome> {
    const picked = await withTransaction(async (tx: Tx) => {
      const { rows } = await tx.query<{ case_id: string; state: string }>(
        `select case_id, state from absence_case
          where state in ('RECONCILE_REQUIRED', 'ATTENTION')
             or (state = 'PREPARING' and stopped_at is not null)
          order by created_at
          for update skip locked
          limit 1`,
      );
      return rows[0];
    });
    if (!picked) return { handled: false };

    return picked.state === "ATTENTION"
      ? tryResumeReporting(picked.case_id)
      : reconcileAdoption(picked.case_id);
  };
}
