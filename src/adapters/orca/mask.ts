/**
 * モデルへ渡す前の自然文のマスク。
 *
 * 出典：RFC-004 §5「自然文はモデル前に不要な連絡先等をマスクする。ただし
 * パターン検知で完全な匿名化を保証しない。」ADR-008。
 *
 * 位置づけ：
 *   - これは**不要な開示を減らす措置**であり、匿名化の保証ではない。
 *     「マスク済みなので安全」と説明しない（ADR-008：自由文をマスクしても
 *     完全匿名化と称さない）。
 *   - 決定的に動く。同じ入力からは必ず同じ出力になる。requestHash の対象に
 *     マスク後の本文を含めても再現できるようにするため。
 *   - MVPは架空データだけを扱う。本番では利用目的・提供先・保持を別途決める。
 */

/** 何をマスクしたかの内訳。原文は含めない。 */
export interface MaskSummary {
  readonly email: number;
  readonly phone: number;
  readonly url: number;
  readonly accountId: number;
}

export interface MaskResult {
  readonly text: string;
  readonly summary: MaskSummary;
  /** 1箇所でもマスクしたか。 */
  readonly masked: boolean;
}

/**
 * 連絡先らしき並びを置き換える。
 *
 * 置換後の文字列は種別が分かる形にする。モデルが「連絡先が書かれていた」ことを
 * 解釈に使えるようにしつつ、値そのものは渡さないため。
 */
const SIMPLE_RULES: {
  readonly kind: keyof MaskSummary;
  readonly pattern: RegExp;
  readonly token: string;
}[] = [
  // メールアドレス。全角＠も対象にする。
  {
    kind: "email",
    pattern: /[A-Za-z0-9._%+-]+[@＠][A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    token: "[メールアドレス]",
  },
  // URL。宛先や外部サービスのIDが含まれ得る。
  //
  // **日本語とASCIIの句読点・括弧で終端させる。** `\S+` だと、URLの直後に空白を
  // 置かず文が続く返信（`詳細はhttps://example.com。18時から22時まで入れます`、
  // `...example.com,18時から...`）で、後続の勤務条件まで取り込んで消してしまう。
  // カンマ・セミコロンを含むURLは途中で切れるが、URLは元々マスク対象であり、
  // 勤務条件を壊すより切れる側へ倒す。
  {
    kind: "url",
    pattern: /https?:\/\/[^\s,;、。，．；：！？「」『』（）〔〕【】〈〉《》…・\u3000]+/g,
    token: "[URL]",
  },
];

/**
 * LINE ID 等のアカウント表記。
 *
 * **ID部分に英字が1文字も無ければマスクしない。** `ID` も区切りも省略できる形に
 * すると、`LINE 18-22で勤務できます` の `18-22` や `line 18時から` の `18` を
 * IDとして飲み込み、勤務条件が消える。実際にそうなっていた。
 *
 * 英字を要求する結果、数字だけのIDは取りこぼす。このモジュールは完全な匿名化を
 * 保証しない（RFC-004 §5）一方、勤務条件を壊すと解釈そのものが成立しないため、
 * 取りこぼす側へ倒す。
 */
const ACCOUNT_ID_PATTERN =
  /(?:LINE|line|ライン)\s*(?:の)?\s*(?:ID|id|ＩＤ|アイディー)?\s*(?:は)?\s*[:：]?\s*([A-Za-z0-9._-]{2,})/g;

/** 独立した @英数字。同じく英字を要求する。 */
const MENTION_PATTERN = /(?<![A-Za-z0-9._-])@([A-Za-z0-9._-]{2,})/g;

/** 英字を含むか。含まなければアカウントIDとして扱わない。 */
function looksLikeAccountId(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

/**
 * 電話番号。
 *
 * **貪欲に拾って後から桁数で捨てる方式を採らない。** 隣に時刻が続く返信
 * （`080-1234-5678 18から勤務できます`）で、候補が `080-1234-5678 18` まで伸び、
 * 13桁になって候補ごと捨てられ、電話番号が素通りする。
 *
 * 代わりに、日本の電話番号の**桁の区切り方を直接並べる**。各分岐の桁数が固定
 * なので、時刻の範囲表記（`0900-1730`）や郵便番号（`060-0001`）、従業員番号には
 * 一致せず、隣に数字が続いても番号部分だけで止まる。
 *
 *   市外局番の桁 - 市内局番の桁 - 加入者番号  合計
 *     2 - 4 - 4                                10
 *     3 - 3 - 4                                10
 *     3 - 4 - 4                                11（携帯・IP）
 *     4 - 3 - 4                                11（0800等）
 *     4 - 3 - 3                                10（0120・0570等）
 *     4 - 2 - 4                                10
 *     5 - 1 - 4                                10
 *     区切り無し                               10〜11
 */
const SEP = "[-.\\s]?";

const PHONE_FORMS = [
  // 市外局番は括弧書きも受ける：(03) 1234-5678
  `\\(?0\\d\\)?${SEP}\\d{4}${SEP}\\d{4}`,
  `\\(?0\\d{2}\\)?${SEP}\\d{4}${SEP}\\d{4}`,
  `\\(?0\\d{2}\\)?${SEP}\\d{3}${SEP}\\d{4}`,
  `\\(?0\\d{3}\\)?${SEP}\\d{3}${SEP}\\d{4}`,
  `\\(?0\\d{3}\\)?${SEP}\\d{3}${SEP}\\d{3}`,
  `\\(?0\\d{3}\\)?${SEP}\\d{2}${SEP}\\d{4}`,
  `\\(?0\\d{4}\\)?${SEP}\\d${SEP}\\d{4}`,
  `0\\d{9,10}`,
  // 国際表記。+81 に続く加入者番号。
  `\\+81${SEP}\\d{1,2}${SEP}\\d{4}${SEP}\\d{4}`,
];

/**
 * 前後の境界：数字・コロン・「時」に隣接しない。
 * 長い分岐から順に試すため、`0\d{2}-\d{4}-\d{4}`（11桁）が
 * `0\d{2}-\d{3}-\d{4}`（10桁）より先に来るよう並べてある。
 */
const PHONE_PATTERN = new RegExp(`(?<![\\d:時])(?:${PHONE_FORMS.join("|")})(?![\\d:時])`, "g");

export function maskContactInfo(text: string): MaskResult {
  const summary: { -readonly [K in keyof MaskSummary]: number } = {
    email: 0,
    phone: 0,
    url: 0,
    accountId: 0,
  };

  let result = text;
  for (const rule of SIMPLE_RULES) {
    result = result.replace(rule.pattern, (match) => {
      // 文末の記号までURLへ取り込まない。`https://x.test/a です。` の `。` など。
      const trimmed = rule.kind === "url" ? match.replace(/[.,;:!?)\]]+$/, "") : match;
      const tail = match.slice(trimmed.length);
      summary[rule.kind] += 1;
      return rule.token + tail;
    });
  }
  for (const pattern of [ACCOUNT_ID_PATTERN, MENTION_PATTERN]) {
    result = result.replace(pattern, (match, id: string) => {
      if (!looksLikeAccountId(id)) return match;
      summary.accountId += 1;
      return "[アカウントID]";
    });
  }
  result = result.replace(PHONE_PATTERN, () => {
    summary.phone += 1;
    return "[電話番号]";
  });

  const masked = Object.values(summary).some((n) => n > 0);
  return { text: result, summary, masked };
}
