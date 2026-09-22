/**
 * 勤務計画の選定（RFC-009 §6、Q02、A16、A11）。担当B。
 *
 * 純粋関数。DBもGatewayも引かない。application（`adopt-plan.ts`）が選定可能な承諾を
 * 集めて渡し、返った計画を不変の `SelectionResult` として保存する。
 *
 * 規則：
 *   - Q02（`COVERAGE_MODE = "EXACTLY_ONE"`）：必要枠の各区間にちょうど1人。承諾区間が
 *     重なる組合せも、隙間が残る組合せも採用しない。
 *   - ADR-005：承諾時間を自動で短縮しない。必要枠から外へはみ出す承諾は、切り詰めれば
 *     使えても**使わない**（そのままでは超過配置になる）。
 *   - 「有効な承諾の和集合で覆える」と「同時に採用できる合法な組合せがある」を
 *     同じbooleanに詰めない。前者だけ成り立つ場合は `OVERLAP` として区別する。
 *   - 優先順位：勤務時間合計 → 人数（少ない方）→ 承諾が揃った順（受信順が早い方）→
 *     安定ID順。超過配置を禁止しているため完全充足計画の勤務時間合計は同率になり、
 *     第1優先は実質的に効かない（RFC-009 §6）。
 *   - 過去の辞退・返信の内容を順位に使わない（AGENTS.md）。入力に無いので使えない。
 *   - Q06／A09：月内入力が `COMPLETE` でなければ月次上限の検査が成立しないので、
 *     計画を選ばず `INPUT_INCOMPLETE` を返す。欠けた日を0と推定しない。
 *
 * 不成立は「この組合せ」の話であり、案件を終了させる理由ではない（A16）。呼出し元は
 * `NOT_FEASIBLE` を受けても調整中のまま据え置く。
 *
 * 候補は最大 `MAX_STAFF`（Q10：8人）。部分集合の列挙は 2^8 = 256 通りで足りる。
 * それを超える入力は範囲外として明示的に断る（黙って先頭だけを見ない）。
 */

import { COVERAGE_MODE, MAX_STAFF } from "@/config/mvp-policy";
import { ERROR_CODES, TaskcalError } from "@/contracts/errors";
import {
  SELECTION_NOT_FEASIBLE_REASON,
  type SelectedCommitment,
  type SelectionCandidate,
  type SelectionNotFeasibleReason,
  type SelectionPlanInput,
  type SelectionPlanner,
  type SelectionResult,
} from "@/contracts/selection";

/** 選定規則の版。fixtureと評価の再現に使う。規則を変えたら上げる。 */
export const SELECTION_RULES_VERSION = `${COVERAGE_MODE.toLowerCase()}/1.0.0`;

type Plan = Omit<SelectionResult, "selectionId" | "decidedAt">;

interface ParsedCandidate {
  readonly candidate: SelectionCandidate;
  readonly startMs: number;
  readonly endMs: number;
}

interface RankedPlan {
  readonly members: readonly ParsedCandidate[];
  readonly totalMinutes: number;
  readonly headcount: number;
  /** 計画が揃った受信順。最後に揃った承諾の受信順で比べる。 */
  readonly completedSeq: number;
  readonly idKey: string;
}

const HAS_EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** 明示のオフセットを持つ日時だけを受ける。サーバのタイムゾーンで解釈しない。 */
function parseInstant(value: string, label: string): number {
  if (!HAS_EXPLICIT_OFFSET.test(value)) {
    throw new TaskcalError(
      ERROR_CODES.INVALID_INPUT,
      `${label}にタイムゾーンの無い日時は受け取れません。`,
    );
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TaskcalError(ERROR_CODES.INVALID_INPUT, `${label}の日時を解釈できません。`);
  }
  return ms;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function notFeasible(input: SelectionPlanInput, reason: SelectionNotFeasibleReason): Plan {
  return {
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    rulesVersion: SELECTION_RULES_VERSION,
    outcome: "NOT_FEASIBLE",
    notFeasibleReason: reason,
    inputs: input.inputs,
    selected: [],
    // Q07：確定した相手だけに通知して他を待たせない。不成立なら全員が非選定。
    notSelectedCommitmentIds: input.candidates.map((c) => c.commitmentId),
  };
}

/**
 * 並べ替えた区間が必要枠をちょうど埋めるか。
 * 開始が必要枠の開始、各区間の開始が直前の終了、最後の終了が必要枠の終了。
 * これで重複も隙間も同時に弾ける（半開区間）。
 */
function exactlyCovers(sorted: readonly ParsedCandidate[], reqStart: number, reqEnd: number) {
  if (sorted.length === 0) return false;
  let cursor = reqStart;
  for (const member of sorted) {
    if (member.startMs !== cursor) return false;
    cursor = member.endMs;
  }
  return cursor === reqEnd;
}

/** 和集合が必要枠を覆うか（重なりは許す）。`OVERLAP` と `NOT_COVERED` の区別に使う。 */
function unionCovers(candidates: readonly ParsedCandidate[], reqStart: number, reqEnd: number) {
  const sorted = [...candidates].sort((a, b) => a.startMs - b.startMs);
  let cursor = reqStart;
  for (const member of sorted) {
    if (member.startMs > cursor) return false;
    cursor = Math.max(cursor, member.endMs);
    if (cursor >= reqEnd) return true;
  }
  return cursor >= reqEnd;
}

function compareRanked(a: RankedPlan, b: RankedPlan): number {
  // 勤務時間合計が多い方（完全充足では同率）→ 人数が少ない方 → 早く揃った方 → ID順。
  if (a.totalMinutes !== b.totalMinutes) return b.totalMinutes - a.totalMinutes;
  if (a.headcount !== b.headcount) return a.headcount - b.headcount;
  if (a.completedSeq !== b.completedSeq) return a.completedSeq - b.completedSeq;
  return compareIds(a.idKey, b.idKey);
}

/**
 * Q02：各区間ちょうど1人で必要枠を覆う計画を選ぶ。
 *
 * `outcome: "NOT_FEASIBLE"` の理由は次のとおり区別する。
 *   - `INPUT_INCOMPLETE`：月内入力が完全でない（Q06／A09）。計画の評価に入らない
 *   - `NO_COMMITMENTS`：選定できる承諾が無い
 *   - `NOT_COVERED`：使える承諾の和集合でも必要枠を覆えない
 *   - `OVERLAP`：和集合では覆えるが、重ならずに覆う組合せが無い（A16）
 */
export function planExactlyOneCoverage(input: SelectionPlanInput): Plan {
  if (input.inputs.monthlyCompleteness !== "COMPLETE") {
    return notFeasible(input, SELECTION_NOT_FEASIBLE_REASON.INPUT_INCOMPLETE);
  }
  if (input.candidates.length === 0) {
    return notFeasible(input, SELECTION_NOT_FEASIBLE_REASON.NO_COMMITMENTS);
  }
  if (input.candidates.length > MAX_STAFF) {
    // Q10の上限。黙って先頭だけを見ると、打診した相手の承諾を無視することになる。
    throw new TaskcalError(
      ERROR_CODES.OUT_OF_SCOPE,
      `承諾が${input.candidates.length}件あり、MVPの上限${MAX_STAFF}件を超えています。`,
    );
  }

  const ids = new Set<string>();
  const staffIds = new Set<string>();
  for (const candidate of input.candidates) {
    if (ids.has(candidate.commitmentId)) {
      throw new TaskcalError(ERROR_CODES.INVALID_INPUT, "同じ承諾IDが複数あります。");
    }
    ids.add(candidate.commitmentId);
    if (staffIds.has(candidate.staffId)) {
      // D04：同一案件・スタッフで選定できる版は一つ。二つ来たら入力が壊れている。
      // 黙って片方を選ばない。
      throw new TaskcalError(
        ERROR_CODES.INVALID_INPUT,
        "同じスタッフの選定可能な承諾が複数あります（D04）。",
      );
    }
    staffIds.add(candidate.staffId);
  }

  const reqStart = parseInstant(input.requirement.startAt, "必要枠");
  const reqEnd = parseInstant(input.requirement.endAt, "必要枠");
  if (reqStart >= reqEnd) {
    throw new TaskcalError(
      ERROR_CODES.INVALID_INPUT,
      "必要枠の開始は終了より前である必要があります。",
    );
  }

  // ADR-005：はみ出す承諾は切り詰めずに除外する。区間が壊れている承諾も使わない。
  const usable: ParsedCandidate[] = [];
  for (const candidate of input.candidates) {
    const startMs = parseInstant(candidate.startAt, "承諾");
    const endMs = parseInstant(candidate.endAt, "承諾");
    if (startMs >= endMs) {
      // 区間が壊れた承諾は入力の破損。黙って除外して非選定通知の宛先にしない（D04）。
      throw new TaskcalError(
        ERROR_CODES.INVALID_INPUT,
        "承諾の開始は終了より前である必要があります。",
      );
    }
    if (startMs < reqStart || endMs > reqEnd) continue;
    usable.push({ candidate, startMs, endMs });
  }
  if (usable.length === 0) {
    return notFeasible(input, SELECTION_NOT_FEASIBLE_REASON.NOT_COVERED);
  }

  // 部分集合を全て評価する。候補は最大8件なので列挙で足りる。
  const plans: RankedPlan[] = [];
  const total = 1 << usable.length;
  for (let mask = 1; mask < total; mask += 1) {
    const members: ParsedCandidate[] = [];
    for (let index = 0; index < usable.length; index += 1) {
      if (mask & (1 << index)) members.push(usable[index]);
    }
    members.sort((a, b) => a.startMs - b.startMs);
    if (!exactlyCovers(members, reqStart, reqEnd)) continue;
    plans.push({
      members,
      totalMinutes: members.reduce((sum, m) => sum + (m.endMs - m.startMs) / 60_000, 0),
      headcount: members.length,
      completedSeq: Math.max(...members.map((m) => m.candidate.committedSeq)),
      idKey: members
        .map((m) => m.candidate.commitmentId)
        .sort(compareIds)
        .join("|"),
    });
  }

  if (plans.length === 0) {
    return notFeasible(
      input,
      unionCovers(usable, reqStart, reqEnd)
        ? SELECTION_NOT_FEASIBLE_REASON.OVERLAP
        : SELECTION_NOT_FEASIBLE_REASON.NOT_COVERED,
    );
  }

  plans.sort(compareRanked);
  const best = plans[0];
  const chosen = new Set(best.members.map((m) => m.candidate.commitmentId));
  const selected: SelectedCommitment[] = best.members.map(({ candidate }) => ({
    commitmentId: candidate.commitmentId,
    commitmentVersion: candidate.commitmentVersion,
    staffId: candidate.staffId,
    // 承諾した区間をそのまま使う。短縮も延長もしない（ADR-005）。
    startAt: candidate.startAt,
    endAt: candidate.endAt,
    plannedShiftAssignmentId: candidate.plannedShiftAssignmentId,
  }));

  return {
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    rulesVersion: SELECTION_RULES_VERSION,
    outcome: "FEASIBLE",
    inputs: input.inputs,
    selected,
    notSelectedCommitmentIds: input.candidates
      .filter((c) => !chosen.has(c.commitmentId))
      .map((c) => c.commitmentId),
  };
}

/** 合成の根が使う口。規則は `planExactlyOneCoverage` にある。 */
export function createSelectionPlanner(): SelectionPlanner {
  return { plan: planExactlyOneCoverage };
}
