/**
 * メッセージ連携の契約（interfaceのみ）。
 *
 * 出典：RFC-011 §6、ADR-019。MVPは模擬受信箱だけを実装する。
 *
 * 方針：
 *   - 宛先の同一性を検査する。途中の宛先変更で旧打診を別人へ送らない。
 *   - 受信本文で名乗った staffId を本人とみなさない。認証された回答者だけを本人とする。
 *   - 重複排除キーは provider・connectionId の範囲を含める（A15）。
 *   - receiveEvent が常に Message を返すとは仮定しない。
 */

import type { DeliveryState, OutreachMessageKind } from "./outreach-state";

/** 宛先。endpointKey が指す宛先は不変にするか、使用版を固定する（RFC-011 §6）。 */
export interface ContactEndpointRef {
  readonly provider: string;
  readonly connectionId: string;
  readonly endpointKey: string;
  /** 打診時に固定した宛先の版。 */
  readonly endpointVersion: number;
}

export interface SendCommand {
  /** 送信操作ごとのキー。意味の違うメッセージを一律抑止せず、二重送信だけを防ぐ。 */
  readonly sendKey: string;
  readonly to: ContactEndpointRef;
  readonly kind: OutreachMessageKind;
  readonly body: string;
}

export interface SendResult {
  readonly sendKey: string;
  readonly state: DeliveryState;
  /**
   * 新規送信か、同じ sendKey による再生か。
   * 区別できないと、打診数・確認数・通知数の指標が水増しされる（RFC-011 §7）。
   */
  readonly match: "NEW" | "REPLAY";
  /** 送信先が返した識別子。照会に使う。 */
  readonly providerMessageId?: string;
  readonly detail?: string;
}

/**
 * 受信イベント。モデル処理の前に永続化する（AGENTS.md）。
 * 返信順は、モデル処理の完了時刻ではなく永続化した受信順で決める。
 */
export interface InboundEvent {
  readonly provider: string;
  readonly connectionId: string;
  /** 接続範囲を含めた重複排除キー。接続単位で重複排除する。 */
  readonly eventId: string;
  /** 送信側で発生した時刻。 */
  readonly occurredAt: string;
  /** こちらが受信した時刻。occurredAt と分ける（RFC-011 §4）。 */
  readonly receivedAt: string;
  readonly from: ContactEndpointRef;
  /** 本文なしのイベントがあり得る。 */
  readonly body?: string;
  /**
   * 署名等による**経路の**検証結果。
   *
   * これは本人確認ではない。「打診対象のスタッフ本人か」は、認証済みの回答者と
   * 宛先の同一性から別途判定する（RFC-011 §3・§6、A15）。
   * `channelVerified === true` を本人の証拠として扱わない。
   */
  readonly channelVerified: boolean;
}

/** 宛先の同一性検査の結果。不一致と検証不能を区別する（A15）。 */
export const ENDPOINT_CHECK = {
  /** 打診時に固定した宛先と一致する。 */
  MATCHES: "MATCHES",
  /** 宛先が変わっている。送らない。旧打診を別人へ送らないため。 */
  CHANGED: "CHANGED",
  /** 確認できない。送らず、要対応として記録する。 */
  UNVERIFIABLE: "UNVERIFIABLE",
} as const;

export type EndpointCheck = (typeof ENDPOINT_CHECK)[keyof typeof ENDPOINT_CHECK];

/**
 * メッセージの連携先。
 *
 * **例外（reject）の意味：成否不明。** `FAILED` と等価ではない。reject 後は
 * `getSendResult` で照合するまで同じ送信を再実行しない（AGENTS.md）。
 * 可能な実装は例外を投げず `state: "UNKNOWN"` を返すこと。
 *
 * 受信経路（`InboundEvent` の取り込み）はこのinterfaceに含めない。受信は
 * 永続化と案件内順序の採番を伴うため、repository側の契約とする（下記参照）。
 */
export interface MessagingGateway {
  send(command: SendCommand): Promise<SendResult>;
  /** 送信結果の照会。ACCEPTED は受付であり到達の保証ではない。 */
  getSendResult(sendKey: string): Promise<SendResult | "LOOKUP_UNAVAILABLE">;
  /**
   * 宛先が現在も同じ相手を指すかを検査する。MATCHES 以外は送信しない。
   * 送信直前の連絡許可は別途検査する（RFC-011 §6）。
   */
  verifyEndpoint(ref: ContactEndpointRef): Promise<EndpointCheck>;
}

/**
 * 永続化された受信イベント。
 *
 * `receivedSeq` はDBで採番する案件内の単調増加値。返信順はこれで決める。
 * `occurredAt`/`receivedAt` の時刻比較で順序を決めない（同時刻・時計ずれで崩れる）。
 * `InboundEvent` は採番前の入力であり、順序の権威を持たない（RFC-011 §4、A12）。
 */
export interface PersistedInboundEvent {
  readonly event: InboundEvent;
  readonly caseId: string;
  /** 案件内で単調増加。モデル処理の完了順ではない。 */
  readonly receivedSeq: number;
}
