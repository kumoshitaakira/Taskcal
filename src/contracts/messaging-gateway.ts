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

import type { OperationId, OperationRef, RequestHash } from "./operation";
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
  /**
   * 送信操作ごとのキーと、内容のハッシュ。
   *
   * `operationId` は送信操作ごとのキー。意味の違うメッセージを一律抑止せず、
   * 二重送信だけを防ぐ。`requestHash` は宛先・種別・本文を固定した内容のハッシュで、
   * 同じキーで内容が変わった要求を**送信前に**拒否するために要る
   * （ADR-006 / RFC-009 D07）。
   *
   * hashが無いと、adapter は変更後の通知を REPLAY として握り潰すか、別内容の
   * 外部作用を実行するかの二択になる。どちらも正しくない。
   */
  readonly operation: OperationRef;
  readonly to: ContactEndpointRef;
  readonly kind: OutreachMessageKind;
  readonly body: string;
}

/**
 * `requestHash` に含める内容。ここに無いものを変えても検出できない。
 *
 * 宛先は `ContactEndpointRef` を**丸ごと**含める。`provider` と `connectionId` を
 * 落とすと、endpointKey・版・種別・本文が同じまま接続先だけ切り替えた再試行が
 * 同じhashになり、宛先の変わった送信を `REPLAY` として握り潰す（A15）。
 */
export interface SendPayloadForHash {
  readonly to: ContactEndpointRef;
  readonly kind: OutreachMessageKind;
  readonly body: string;
}

/**
 * 送信しなかった理由。
 *
 * **いずれも外部作用は起きていない。** 失敗（`DeliveryState.FAILED`）とは別で、
 * 再試行の判断が変わる。
 */
export const SEND_REFUSAL = {
  /** 打診時に固定した宛先版と、現在の宛先が一致しない（A15）。 */
  ENDPOINT_CHANGED: "ENDPOINT_CHANGED",
  /** 送信直前の時点で連絡許可が無い（RFC-011 §6）。 */
  NOT_PERMITTED: "NOT_PERMITTED",
  /** 同じ operationId で内容が異なる（D07）。 */
  CONFLICT: "CONFLICT",
} as const;

export type SendRefusal = (typeof SEND_REFUSAL)[keyof typeof SEND_REFUSAL];

export interface SendRefused {
  readonly refused: SendRefusal;
  /** 表示用の短い理由。原文や秘密値を入れない。 */
  readonly detail?: string;
}

export interface SendResult {
  /**
   * 保存されていた操作の参照。**`requestHash` を含めて返す。**
   *
   * 照会した結果が本当に今の要求のものかを、呼出し元が照合できるようにする。
   * ScheduleGateway の `UpdateResult` と同じ形にそろえる。
   */
  readonly operation: OperationRef;
  readonly state: DeliveryState;
  /**
   * 新規送信か、同じ operationId・同じ内容による再生か。
   * 区別できないと、打診数・確認数・通知数の指標が水増しされる（RFC-011 §7）。
   *
   * 内容が異なる要求は `SendRefused`（`CONFLICT`）で返す。ここには現れない。
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
  /**
   * 返信の対象になった送信Messageの不変参照（RFC-011 §3）。
   *
   * **宛先だけで打診を逆引きしない。** 同じ相手へ過去の案件でも打診していると、
   * 古い打診への返信を現在の案件の承諾として扱ってしまう。対象を特定できない
   * 返信は記録するが、承諾には使わない。
   *
   * 将来のLINE等、対象参照を持たない経路では省略され得る。その場合は本人と
   * 確認できない受信として扱う。
   */
  readonly inReplyToMessageId?: string;
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
  /**
   * 送信する。
   *
   * **宛先の検査は、この操作の内部で外部作用の直前に行う。**
   * `verifyEndpoint` を先に呼んで `MATCHES` を得ても、その後に宛先の版や連絡許可が
   * 変わり得る。検査と送信を別の操作にすると、その間が競合窓になり、旧宛先へ
   * 送ってしまう（A15、RFC-011 §6）。`send` は `command.to.endpointVersion` を
   * 現在の宛先と照合し、連絡許可も確認してから送る。
   *
   * 不一致・不許可・内容不一致は `SendRefused` を返す。**いずれも送信していない。**
   * 配送の失敗（`DeliveryState.FAILED`）とは区別する。
   *
   * 同じ `operationId` で `requestHash` が一致すれば、再送せず保存済み結果を
   * `REPLAY` として返す。モデル呼出し側（`src/adapters/orca`）と同じ規則。
   */
  send(command: SendCommand): Promise<SendResult | SendRefused>;
  /**
   * 送信結果の照会。ACCEPTED は受付であり到達の保証ではない。
   *
   * 接続範囲を含めて照会する（宛先を切り替えた後に別接続の結果を拾わないため）。
   * 返る `SendResult.operation.requestHash` を呼出し元が照合する。ID を誤って
   * 再利用した場合に、内容の違う古い結果を今の要求へ結び付けないため。
   * `expectedRequestHash` を渡した場合、adapter 側でも照合して不一致なら
   * `"CONFLICT"` を返す。
   */
  getSendResult(ref: {
    operationId: OperationId;
    connectionId: string;
    expectedRequestHash?: RequestHash;
  }): Promise<SendResult | "LOOKUP_UNAVAILABLE" | "CONFLICT">;
  /**
   * 宛先が現在も同じ相手を指すかを検査する。
   *
   * **これは送信の前提条件ではなく、画面表示・診断のための照会。**
   * ここで `MATCHES` を得ても、送信までの間に変わり得る。送信の安全は `send`
   * 自身の再検査で担保する（上記）。この結果を根拠に `send` の検査を省かない。
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
