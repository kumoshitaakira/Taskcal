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
const RULES: {
  readonly kind: keyof MaskSummary;
  readonly pattern: RegExp;
  readonly token: string;
}[] = [
  // メールアドレス。
  {
    kind: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    token: "[メールアドレス]",
  },
  // URL。宛先や外部サービスのIDが含まれ得る。
  { kind: "url", pattern: /https?:\/\/\S+/g, token: "[URL]" },
  // LINE ID 等のアカウント表記。
  {
    kind: "accountId",
    pattern: /(?:LINE|line)\s*(?:ID|id)\s*[:：]?\s*[A-Za-z0-9._-]{2,}/g,
    token: "[アカウントID]",
  },
  // 電話番号。日本の一般的な表記（区切りあり・なし、国番号つき）を対象にする。
  {
    kind: "phone",
    pattern: /(?:\+81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/g,
    token: "[電話番号]",
  },
];

export function maskContactInfo(text: string): MaskResult {
  const summary: { -readonly [K in keyof MaskSummary]: number } = {
    email: 0,
    phone: 0,
    url: 0,
    accountId: 0,
  };

  let result = text;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, () => {
      summary[rule.kind] += 1;
      return rule.token;
    });
  }

  const masked = Object.values(summary).some((n) => n > 0);
  return { text: result, summary, masked };
}
