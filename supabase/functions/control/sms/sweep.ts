/**
 * 자동 문자 스윕 — 매 틱 한 번, 자동발송을 켠 예약에서 지금 나갈 것을 내보낸다.
 *
 * 판정(`schedule.ts`)과 발송(`dispatch.ts`)을 이어 붙이기만 한다. 기기 자동화의
 * `handlers/automation.ts`가 하는 역할과 같은 자리다.
 *
 * **한 예약에서 넘어져도 다음 예약으로 간다.** 여기서 예외가 밖으로 나가면 그 뒤 예약의
 * 문자가 통째로 안 나가고, 무인 운영에서 그 사실을 아무도 모른다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { dispatch, markExpired, markNoPhone, type SmsReservation } from "./dispatch.ts";
import { plan } from "./schedule.ts";
import { loadConfig, normalizePhone } from "./solapi.ts";

/** 스윕이 필요로 하는 예약 필드. `store.fetchRecent`가 이미 전부 실어 온다. */
export interface SweepReservation extends SmsReservation {
  sms_auto: boolean;
}

export interface SweepResult {
  sent: number;
  failed: number;
  no_phone: number;
  expired: number;
  /** 결과 불명 — 벤더가 받았을 수 있어 자동 재시도를 멈춘 것. 사람이 콘솔에서 확인해야 한다. */
  unknown: number;
}

/**
 * 자동발송이 켜진 예약들을 훑는다.
 *
 * 시크릿이 없으면 **아무것도 적지 않고** 콘솔에만 남긴다. 장부에 실패로 쌓으면 시크릿을
 * 다시 넣었을 때 이미 자리가 막혀 있고, 그렇다고 재시도 가능한 상태로 적으면 매 틱
 * 같은 실패가 쌓인다. 설정 누락은 예약의 문제가 아니라 서버의 문제라, 예약별 장부에
 * 적을 사건이 아니다 — 어드민에서 보내려 하면 그쪽은 503으로 즉시 알려준다.
 */
export async function sweepSms(
  sb: SupabaseClient,
  reservations: SweepReservation[],
  now: Date,
): Promise<SweepResult> {
  const result: SweepResult = { sent: 0, failed: 0, no_phone: 0, expired: 0, unknown: 0 };

  const targets = reservations.filter((r) => r.sms_auto);
  if (targets.length === 0) return result;

  if (!loadConfig()) {
    console.error("SOLAPI 미설정 — 자동 문자를 건너뛴다 (자동발송이 켜진 예약 " + targets.length + "건)");
    return result;
  }

  for (const r of targets) {
    try {
      const { fire, expired } = plan(r, now);

      for (const kind of fire) {
        // 번호가 없으면 보낼 수 없다. 여기서 조용히 넘기면 자동발송을 켜 둔 사람은
        // 나갔다고 믿는다 — 장부와 채널에 남겨 사람이 번호를 채우게 만든다.
        if (!normalizePhone(r.phone)) {
          if (await markNoPhone(sb, r, kind)) result.no_phone++;
          continue;
        }
        const sent = await dispatch(sb, r, kind, "auto");
        if (sent.status === "sent") result.sent++;
        else if (sent.status === "failed") result.failed++;
        else if (sent.status === "unknown") result.unknown++;
        // `already`는 세지 않는다 — 할 일이 없었다는 뜻이라 0이 맞다.
        // 다만 **수동으로 틱을 찔러 디버깅할 때 이게 헷갈린다**: pg_cron이 1분마다 먼저
        // 선점하므로, 손으로 부른 틱은 방금 나간 문자에 대해서도 0을 돌려준다.
        // 안 나간 것 같으면 카운터가 아니라 `reservation_sms` 장부를 본다(2026-08-08에 겪었다).
      }

      for (const kind of expired) {
        if (await markExpired(sb, r, kind)) result.expired++;
      }
    } catch (e) {
      console.error("자동 문자 실패 — 다음 예약으로 넘어간다", r.id, e);
    }
  }

  return result;
}
