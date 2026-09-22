# ADR-026：CSV管理版ストアと、営業日単位の正式版参照の同期

日付：2026-09-22／状態：**提案（Day 4で実装済み。ユーザーとA/Bの確認待ち）**。確認前に採用済みへは変えない（AGENTS.md）
詳細：[RFC-010](../rfc/RFC-010-csv-authority.md) §2〜§7・§10、[ADR-016](ADR-016-csv-adoption.md)、[ADR-019](ADR-019-gateway-contract.md)
実装：`src/adapters/csv/csv-store.ts`、`src/adapters/csv/csv-schedule-gateway.ts`、`AuthoritativeScheduleRefRepository.advanceSiblings`

## 背景

RFC-010は「管理版CSV（不変）」「正式版参照（現在有効な管理版を指すメタデータ）」「作業用出力」を
分けると定めたが、ファイルの置き方、`ScheduleGateway` の各能力が何を保証するか、そして
**管理版が月単位の成果物なのに正式版参照が営業日単位の行である**ことの扱いは決めていなかった。
Day 4に `ScheduleGateway` を実装するにあたり、次の3点を決めた。

## 決定

### 1. 管理版は内容アドレスの不変ストアに置く

```text
var/schedule/<接続>/revisions/<sourceRevision>/{schedule.csv, manifest.json}
var/schedule/<接続>/operations/<操作ID>.json
```

`sourceRevision` は `parseMonthlyCsv` が勤務内容と範囲宣言から計算するSHA-256。同じ内容は同じ場所に
落ち、別の内容は別の場所へ入る。一度書いた版は書き換えない。書込みは一時ディレクトリへ完全に
書いてから rename する（半端な版が正式な場所に現れない）。

**ストアにあることと正式版であることは別。** 正式版はDBの `authoritative_schedule_ref` だけが決める。
`applyUpdate` が作った版も、採用取引が参照を切り替えるまでは「未採用の成果物」として保持される
だけで、勤務照会には混ざらない（RFC-010 §4「5で失敗した成果物は未採用として保持・整理し、
勤務照会に混ぜない」）。「作業用領域」と「正式参照」を別ディレクトリで分けるのではなく、
不変ストア＋DBの参照で分ける。

### 2. Gateway の能力は次の意味に限定する

| 能力 | 意味 | 保証しないこと |
|---|---|---|
| `canConditionalUpdate: true` | 期待版から派生した成果物しか作らない。期待版がストアに無ければ `CONFLICT` | 期待版が**今も**正式版であること。これはDB側の期待版付きCAS（`swap`）が止める（RFC-010 §5） |
| `supportsIdempotencyKey: true` | 同じ操作IDは記録を再生し、内容ハッシュが違えば `CONFLICT` | — |
| `supportsResultLookup: true` | 操作記録を照会できる。記録が無ければ `NOT_APPLIED`、接続自体を知らなければ `LOOKUP_UNAVAILABLE` | 「記録が無い＝未反映」はローカルの管理版ストアでだけ成り立つ。記録は成果物の**後**に書くので、無ければ成果物は報告も採用もされていない。SaaSへは持ち出さない |
| `supportsAtomicBatch: true` | 成果物は1ディレクトリへの rename で現れ、一部だけ書かれた版は正式な場所に存在しない | — |

`mode: "EXPORT_ONLY"` は読取専用接続（A14）で、成果物を作るが `EXPORTED_ONLY` を返す。合成の根では
`ADOPT` 固定で、モード切替の設定は置いていない。

### 3. 採用取引で同月の他営業日の参照も同じ版へ進める

管理版は月単位、参照は営業日単位。対象日の行だけを `swap` で切り替えると、他の営業日の参照が旧版を
指したまま残り、**次の案件が旧版を読んで今回の代替勤務と欠勤を見ない**。月次割当上限（Q06）が
狂う（A01／A09）。

そこで採用取引（`adopt-plan.ts` 手順6）は、対象日を期待版付き `swap` で切り替えた**後**、
`advanceSiblings` で同月・同接続の、旧版を指す他営業日の参照を同じ新版へ進める（版も進める）。
旧版以外を指す行が同月に残っていれば整合が取れていないので、採用取引ごと巻き戻す（D06）。
MVPは同時1案件（D02）なので通常は起きないが、起きたときに一部だけ新版にしない。

## 選択肢

| 案 | 判断 |
|---|---|
| 内容アドレスの不変ストア＋DB参照（採用） | RFC-010 §2〜§4の区別をそのまま表せる。作業用と正式版の複製が要らない |
| 作業用ディレクトリと正式ディレクトリを分けて採用時に移動 | ファイル移動がDB取引の外になり、採用後に移動が失敗すると参照先が無くなる。不変ストアなら採用前後でファイルは動かない |
| 参照を（接続, 月）単位へ変える migration | 正しいが、`schedule` を営業日単位に置いた 0002・0007 と読取り経路を変える。Day 4に収まらないので採らず、参照を一括で進める運用にした |
| Gateway が自前で「現在版」ポインタを持つ | ファイルとDBを1取引にできないので、二つの正本ができる。採らない |

## 帰結

- 正式版参照の切替と管理版の生成が分かれたまま、A01（次案件がR2を読む）とA02（未採用CSVを数えない）が
  本番経路で成立する。
- 管理版ストアは増え続ける（未採用の版も残る）。整理は運用作業として別途決める。MVPでは `reset:dev`。
- 「記録が無い＝未反映」の判断は adapter 内に閉じる。将来のSaaS adapter は `LOOKUP_UNAVAILABLE` か
  `UNKNOWN` を返すこと。
- 参照を営業日単位のまま残したので、月をまたぐ管理版や複数月の同時運用は扱わない（範囲外）。

## 検証・見直し

`tests/unit/csv-schedule-gateway.test.ts`、`tests/integration/csv-adoption.test.ts`（30営業日の参照が
同じ版へ進むこと）、`tests/integration/start-outreach.test.ts`。実SaaSを繋ぐとき、能力の表と
`getUpdateResult` の意味を別RFCで決め直す。参照の粒度を変えるなら新しいADRにする。
