import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getStaffViews } from "@/application/staff-view";
import { Notice } from "../_components/notice";
import { submitReplyAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const staff = await getStaffViews();

  return (
    <main>
      <h1>スタッフ画面（模擬受信箱）</h1>
      <p className="lede">
        架空スタッフ役の受信箱です。届いた打診に返信すると、受信イベントとして記録されます。
      </p>
      <nav className="links">
        <Link href="/">トップ</Link>
        <Link href="/manager">店長画面</Link>
      </nav>

      <Notice
        code={typeof params.n === "string" ? params.n : undefined}
        count={typeof params.c === "string" ? params.c : undefined}
      />

      <div className="notice">
        ここでの役の切替は<strong>本人認証ではありません</strong>
        。架空スタッフのローカルな切替であり、 本番の本人確認とは別です（RFC-011
        §6）。返信本文で名乗ったスタッフIDも本人の証拠にしません。
      </div>

      {staff.length === 0 ? (
        <div className="panel">
          <p className="lede" style={{ margin: 0 }}>
            スタッフがいません。<code>npm run seed:dev</code> で架空データを入れてください。
          </p>
        </div>
      ) : null}

      {staff.map((person) => (
        <section key={person.staffId}>
          <h2>{person.name}</h2>
          {person.inbox.length === 0 ? (
            <div className="panel">
              <p className="lede" style={{ margin: 0 }}>
                届いているメッセージはありません。
              </p>
            </div>
          ) : (
            person.inbox.map((item) => (
              <div className="panel" key={item.inboxItemId}>
                <pre className="message">{item.body}</pre>
                {item.endpoint ? (
                  <form action={submitReplyAction}>
                    {/* 宛先は打診時に固定した版をそのまま送る。画面の現在値で上書きしない（A15）。 */}
                    <input type="hidden" name="provider" value={item.endpoint.provider} />
                    <input type="hidden" name="connectionId" value={item.endpoint.connectionId} />
                    <input type="hidden" name="endpointKey" value={item.endpoint.endpointKey} />
                    <input
                      type="hidden"
                      name="endpointVersion"
                      value={item.endpoint.endpointVersion}
                    />
                    {/* 返信対象の不変参照。どの打診への返信かをこれで決める（RFC-011 §3）。
                        宛先だけで逆引きすると、同じ相手への過去の打診と区別できない。 */}
                    <input type="hidden" name="inReplyToMessageId" value={item.messageId} />
                    {/* 描画時に決めるので、二重送信が同じ受信イベントになる。 */}
                    <input type="hidden" name="eventId" value={`ui-${randomUUID()}`} />
                    <label htmlFor={`body-${item.inboxItemId}`}>返信</label>
                    <textarea
                      id={`body-${item.inboxItemId}`}
                      name="body"
                      rows={2}
                      required
                      placeholder="例：大丈夫です／19時からなら行けます／今回は難しいです"
                    />
                    <button type="submit">返信する</button>
                  </form>
                ) : (
                  <p className="lede">この通知には返信できません。</p>
                )}
              </div>
            ))
          )}

          {person.replies.length > 0 ? (
            <div className="panel">
              <dl>
                {person.replies.map((reply) => (
                  <div className="row" key={`${reply.receivedAt}:${reply.body}`}>
                    <dt>送信済みの返信</dt>
                    <dd>{reply.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </section>
      ))}

      <div className="notice">
        返信の解釈（承諾になるかどうか）は未実装です。OrcaRouterの接続情報と金額予算が未取得のため、
        実推論を行っていません。返信は記録され、打診の状態だけが「回答済み」へ進みます。
      </div>
    </main>
  );
}
