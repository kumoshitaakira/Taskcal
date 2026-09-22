import type { ComponentStatus, RuntimeStatus } from "@/application/runtime-status";

const LABEL: Record<ComponentStatus, string> = {
  OK: "正常",
  CONFIGURED_UNVERIFIED: "設定あり・未検証",
  UNCONFIGURED: "未設定",
  UNAVAILABLE: "接続できない",
  NOT_IMPLEMENTED: "未実装",
};

const TAG_CLASS: Record<ComponentStatus, string> = {
  OK: "tag tag-ok",
  CONFIGURED_UNVERIFIED: "tag tag-warn",
  UNCONFIGURED: "tag tag-warn",
  UNAVAILABLE: "tag tag-bad",
  NOT_IMPLEMENTED: "tag tag-warn",
};

export function StatusTag({ status }: { status: ComponentStatus }) {
  return <span className={TAG_CLASS[status]}>{LABEL[status]}</span>;
}

export function StatusPanel({ status }: { status: RuntimeStatus }) {
  return (
    <div className="panel">
      <dl>
        <div className="row">
          <dt>データベース</dt>
          <dd>
            <StatusTag status={status.database.status} />{" "}
            {status.database.latestMigration ?? "migration未適用"}
          </dd>
        </div>
        <div className="row">
          <dt>worker</dt>
          <dd>
            <StatusTag status={status.worker.status} />{" "}
            {status.worker.beatAt ? `最終heartbeat ${status.worker.beatAt}` : "未起動"}
          </dd>
        </div>
        <div className="row">
          <dt>OrcaRouter</dt>
          <dd>
            <StatusTag status={status.orcaRouter.status} />{" "}
            {status.orcaRouter.budgetConfigured ? "金額予算あり" : "金額予算 未設定"}
            {/* 設定の有無と、実際に通ったかを分けて出す（AGENTS.md「品質と証拠」）。 */}
            ／実呼出し {status.orcaRouter.succeededCalls} 件成功
            {status.orcaRouter.unknownCalls > 0
              ? `・${status.orcaRouter.unknownCalls} 件は結果不明（費用は0にしていません）`
              : ""}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function NotImplementedList({ items }: { items: readonly string[] }) {
  return (
    <>
      <h2>未実装</h2>
      <p className="lede">以下はまだ動きません。デモで完成扱いにしないでください。</p>
      <ul className="plain">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}
