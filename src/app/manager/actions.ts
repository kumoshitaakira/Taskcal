/**
 * 店長画面の状態変更（ADR-006 / D07）。
 *
 * Server Action を入口にしている理由：
 *   - サーバーコンポーネントが描画時に作った操作IDを hidden input に埋められる。
 *     二重クリック・再読込・戻る操作がすべて同じ操作IDになり、`operation_result`
 *     の照合で REPLAY になる。冪等キーを画面層まで通す最短の形。
 *   - `"use client"` を増やさずに済む。JSが無くてもフォーム送信は動く。
 *
 * 結果は通知コードを付けたredirectで返す（`_components/notice.tsx`）。戻り値を
 * 画面へ出すには `useActionState` が要り、クライアントコンポーネントが増えるため。
 *
 * 外部から叩ける安定したURLが要る経路（模擬providerの受信）は Route Handler にする。
 */

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { buildAppServices } from "@/application/deps";
import { ERROR_CODES, TaskcalError, type ErrorCode } from "@/contracts/errors";
import { NOTICE, type NoticeCode } from "../_components/notice";

function back(path: string, code: NoticeCode, count?: number): never {
  const query = count === undefined ? `?n=${code}` : `?n=${code}&c=${count}`;
  redirect(`${path}${query}`);
}

/** 失敗の理由コードを、画面に出す通知コードへ写す。 */
function caseNoticeOf(code: ErrorCode): NoticeCode {
  switch (code) {
    case ERROR_CODES.OPERATION_CONFLICT:
      return NOTICE.CASE_CONFLICT;
    case ERROR_CODES.OUT_OF_SCOPE:
      return NOTICE.CASE_OUT_OF_SCOPE;
    case ERROR_CODES.RECONCILE_REQUIRED:
      return NOTICE.CASE_RECONCILE;
    default:
      return NOTICE.CASE_INVALID;
  }
}

function outreachNoticeOf(code: ErrorCode): NoticeCode {
  switch (code) {
    case ERROR_CODES.CASE_STOPPED:
      return NOTICE.OUTREACH_STOPPED;
    case ERROR_CODES.DEADLINE_EXCEEDED:
      return NOTICE.OUTREACH_DEADLINE;
    case ERROR_CODES.OPERATION_CONFLICT:
      return NOTICE.OUTREACH_CONFLICT;
    default:
      return NOTICE.FAILED;
  }
}

export async function createAbsenceCaseAction(formData: FormData): Promise<void> {
  const operationId = String(formData.get("operationId") ?? "");
  const storeId = String(formData.get("storeId") ?? "");
  const connectionId = String(formData.get("connectionId") ?? "");
  const absentShiftAssignmentId = String(formData.get("shiftAssignmentId") ?? "");
  const deadlineLocal = String(formData.get("deadlineAt") ?? "");
  const timeZoneOffset = String(formData.get("timeZoneOffset") ?? "");

  if (!operationId || !storeId || !connectionId || !absentShiftAssignmentId || !deadlineLocal) {
    back("/manager", NOTICE.INPUT_MISSING);
  }

  const services = buildAppServices();
  // `datetime-local` は timezone を持たない。店舗timezoneのoffsetを付けて解釈する
  // （実行環境のtimezoneで解釈すると、店舗と実行環境がずれたときに時刻が変わる）。
  const result = await services.createAbsenceCase({
    operationId,
    storeId,
    connectionId,
    absentShiftAssignmentId,
    deadlineAt: `${deadlineLocal}:00${timeZoneOffset || "Z"}`,
    runId: `run-${new Date().toISOString().slice(0, 10)}`,
  });

  revalidatePath("/manager");
  if (!result.ok) back("/manager", caseNoticeOf(result.code));
  back("/manager", result.replayed ? NOTICE.CASE_REPLAYED : NOTICE.CASE_CREATED);
}

export async function startOutreachAction(formData: FormData): Promise<void> {
  const operationId = String(formData.get("operationId") ?? "");
  const caseId = String(formData.get("caseId") ?? "");
  if (!operationId || !caseId) back("/manager", NOTICE.INPUT_MISSING);

  const services = buildAppServices();
  const result = await services.startOutreach({ operationId, caseId });

  revalidatePath("/manager");
  revalidatePath("/staff");
  if (!result.ok) back("/manager", outreachNoticeOf(result.code));
  if (result.started === 0) back("/manager", NOTICE.OUTREACH_NONE);
  back(
    "/manager",
    result.replayed ? NOTICE.OUTREACH_REPLAYED : NOTICE.OUTREACH_STARTED,
    result.started,
  );
}

/**
 * 正式採用の失敗理由を通知コードへ写す。
 *
 * **未実装・結果不明・拒否を同じ文言に畳まない。** 畳むと「まだ繋がっていない」と
 * 「やってみて断られた」と「成否が分からない」が区別できず、採用していないのに
 * 失敗したように、あるいは失敗したのに単なる未実装のように読める（ADR-022）。
 */
function adoptNoticeOf(code: ErrorCode, outcome?: "REJECTED" | "RECONCILE_REQUIRED"): NoticeCode {
  if (outcome === "RECONCILE_REQUIRED") return NOTICE.ADOPT_RECONCILE;
  switch (code) {
    case ERROR_CODES.NOT_IMPLEMENTED:
    case ERROR_CODES.NOT_CONFIGURED:
      return NOTICE.ADOPT_NOT_IMPLEMENTED;
    case ERROR_CODES.CASE_STOPPED:
      return NOTICE.ADOPT_STOPPED;
    case ERROR_CODES.DEADLINE_EXCEEDED:
      return NOTICE.ADOPT_DEADLINE;
    case ERROR_CODES.RECONCILE_REQUIRED:
      return NOTICE.ADOPT_RECONCILE;
    case ERROR_CODES.OPERATION_CONFLICT:
    case ERROR_CODES.REVISION_CONFLICT:
      return NOTICE.ADOPT_CONFLICT;
    default:
      return NOTICE.ADOPT_REJECTED;
  }
}

export async function adoptPlanAction(formData: FormData): Promise<void> {
  const operationId = String(formData.get("operationId") ?? "");
  const caseId = String(formData.get("caseId") ?? "");
  if (!operationId || !caseId) back("/manager", NOTICE.INPUT_MISSING);

  const services = buildAppServices();
  // 想定外の例外を素通りさせない。Next のエラー画面になると、店長には「停止」
  // 「拒否」「結果不明」のどれでもない未定義の状態に見え、その場で復帰できない。
  // redirect は例外で実現されているので、ここで握り潰さないよう外へ出す。
  let result;
  try {
    result = await services.adoptPlan({ operationId, caseId });
  } catch (error) {
    if (error instanceof TaskcalError) {
      revalidatePath("/manager");
      back("/manager", adoptNoticeOf(error.code));
    }
    throw error;
  }

  revalidatePath("/manager");
  revalidatePath("/staff");
  if (!result.ok) back("/manager", adoptNoticeOf(result.code, result.outcome));
  if (result.outcome === "NOT_FEASIBLE") back("/manager", NOTICE.ADOPT_NOT_FEASIBLE);
  // 採用済みと読戻し一致は別。一致していなければ要対応だが、採用は取り消さない（D09）。
  const code = !result.readBackMatches
    ? NOTICE.ADOPT_ATTENTION
    : result.replayed
      ? NOTICE.ADOPT_REPLAYED
      : NOTICE.ADOPT_ADOPTED;
  back("/manager", code, result.adopted);
}

/**
 * 停止の結果を通知コードへ写す。
 *
 * **「停止した」と「停止を記録して行き先を保留した」を同じ文言に畳まない。**
 * 畳むと、並行する正式採用がまだ決着していない案件を終了済みとして読ませる（Q13）。
 */
function stopNoticeOf(to: string): NoticeCode {
  switch (to) {
    case "CANCELLED":
      return NOTICE.STOP_CANCELLED;
    case "HANDED_OFF":
      return NOTICE.STOP_HANDED_OFF;
    case "COMMITTED":
      return NOTICE.STOP_COMMITTED;
    case "RECONCILE_REQUIRED":
      return NOTICE.STOP_RECONCILE;
    default:
      return NOTICE.STOP_DEFERRED;
  }
}

export async function stopCaseAction(formData: FormData): Promise<void> {
  const operationId = String(formData.get("operationId") ?? "");
  const caseId = String(formData.get("caseId") ?? "");
  if (!operationId || !caseId) back("/manager", NOTICE.INPUT_MISSING);

  const services = buildAppServices();
  let result;
  try {
    // 画面からの停止は店長の明示的な意思。期限・上限による停止は worker が行う。
    result = await services.stopCase({ operationId, caseId, cause: "MANAGER_STOP" });
  } catch (error) {
    if (error instanceof TaskcalError) {
      revalidatePath("/manager");
      back("/manager", NOTICE.FAILED);
    }
    throw error;
  }

  revalidatePath("/manager");
  revalidatePath("/staff");
  if (!result.ok) {
    back(
      "/manager",
      result.code === ERROR_CODES.CASE_STOPPED ? NOTICE.STOP_ALREADY : NOTICE.STOP_NOT_ALLOWED,
    );
  }
  back("/manager", stopNoticeOf(result.to), result.notified);
}
