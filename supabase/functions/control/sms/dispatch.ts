/**
 * 문자 한 통을 실제로 내보내는 유일한 경로 — 어드민 클릭도 cron도 여기를 지난다.
 *
 * 두 입구가 같은 함수를 쓰는 것이 핵심이다. 나누면 '어드민으로는 되는데 자동으로는 안 나가는'
 * 차이가 조용히 생기고, 그 차이는 손님이 문자를 못 받은 뒤에야 발견된다.
 *
 * 순서가 곧 안전장치다: **선점 → 발송 → 기록 → 알림.**
 * 선점을 발송 뒤로 옮기면 겹친 두 호출이 같은 문자를 두 번 보낸다(`automate`는 anon key로
 * 누구나 부를 수 있다). 기존 `store.claimTransition`·`events.claimPending`과 같은 이유다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { loadConfig, normalizePhone, send } from "./solapi.ts";
import { formatSlot, render, type SmsKind } from "./templates.ts";
import { notifyExpired, notifyFailed, notifySent, notifyUnknown } from "./notify.ts";

/** 문자를 보내는 데 필요한 예약 필드. 예약 행 전체를 알 필요가 없다. */
export interface SmsReservation {
  id: string;
  name: string;
  phone: string | null;
  date: string;
  start_time: string;
  end_time: string;
  deposit_required: boolean;
}

export type DispatchStatus =
  /** 실제로 나갔다. */
  | "sent"
  /** 벤더가 거절했거나 못 닿았다. 장부에 사유가 남고 채널에 ⚠️가 뜬다. */
  | "failed"
  /** 결과 불명(타임아웃·네트워크·5xx). 벤더가 받았을 수 있어 재발송하지 않고 자리를 막는다 — 사람이 콘솔 확인. */
  | "unknown"
  /** 이미 보냈거나 다른 호출이 보내는 중. 아무것도 하지 않았다. */
  | "already"
  /** 연락처가 없거나 문자를 받을 수 없는 번호. 사람이 복사해 보내는 경로로 간다. */
  | "no_phone"
  /** SOLAPI 시크릿이 없다. 장부에 적지 않는다 — 시도조차 못 한 것이라 '실패'와 다르다. */
  | "not_configured";

export interface DispatchResult {
  status: DispatchStatus;
  error?: string;
}

/** Postgres unique_violation. 선점에 진 쪽이 받는 신호다. */
const UNIQUE_VIOLATION = "23505";

/** 알림에 실을 맥락. 어드민이 눌렀는지 cron이 보냈는지는 읽는 사람에게 전혀 다른 정보다. */
export type Origin = "auto" | "admin";

/**
 * 한 통 보낸다.
 *
 * 실패해도 예외를 던지지 않는다 — 자동 스윕이 한 예약에서 넘어지면 그 뒤 예약이 통째로
 * 안 나간다. 다만 **장부 기록 자체가 실패하면 던진다.** 그건 '문자가 실패했다'가 아니라
 * '무엇이 나갔는지 더 이상 모른다'는 뜻이라, 조용히 계속 보내면 안 된다.
 */
export async function dispatch(
  sb: SupabaseClient,
  r: SmsReservation,
  kind: SmsKind,
  origin: Origin,
): Promise<DispatchResult> {
  const cfg = loadConfig();
  if (!cfg) return { status: "not_configured" };

  const phone = normalizePhone(r.phone);
  if (!phone) return { status: "no_phone" };

  const body = render(kind, r);

  // 선점. 유니크 인덱스가 겹친 호출 중 하나만 통과시킨다.
  const { data: claimed, error: claimError } = await sb
    .from("reservation_sms")
    .insert({ reservation_id: r.id, kind, status: "sending", to_phone: phone, body })
    .select("id")
    .single();

  if (claimError) {
    if (claimError.code === UNIQUE_VIOLATION) return { status: "already" };
    throw new Error(`문자 장부 기록 실패: ${claimError.message}`);
  }

  const ctx = { name: r.name, kind, slot: formatSlot(r), origin };
  const result = await send(cfg, phone, body);

  if (result.ok) {
    // 여기서 함수가 죽으면 행이 'sending'에 남아 다음 시도를 막는다 — **안전한 쪽으로 죽는다.**
    // 문자는 이미 나갔으므로, 막히는 것이 두 번 가는 것보다 낫다. 어드민이 재발송으로 푼다.
    await sb
      .from("reservation_sms")
      .update({ status: "sent", sent_at: new Date().toISOString(), group_id: result.groupId })
      .eq("id", claimed.id);
    await notifySent(ctx);
    return { status: "sent" };
  }

  if (result.failure === "unknown") {
    // 결과 불명 — 벤더가 받았을 수 있으므로 재발송하지 않는다. `unknown`은 유니크 인덱스
    // 안이라 자리를 막아 다음 틱이 재시도하지 못한다 — 사람이 SOLAPI 콘솔에서 확인 후 어드민 재발송한다.
    await sb
      .from("reservation_sms")
      .update({ status: "unknown", error: result.error })
      .eq("id", claimed.id);
    await notifyUnknown(ctx, phone, result.error);
    return { status: "unknown", error: result.error };
  }

  // 확정 거절(4xx·건별 거절) — failed는 유니크 인덱스 밖이라 다음 틱이 자동 재시도한다.
  await sb
    .from("reservation_sms")
    .update({ status: "failed", error: result.error })
    .eq("id", claimed.id);
  await notifyFailed(ctx, phone, result.error);
  return { status: "failed", error: result.error };
}

/**
 * 보낼 시각을 놓친 것을 장부에 남긴다. 이후 자동 발송에서 제외되지만 **조용하지는 않다** —
 * 안 나간 문자를 아무도 모르면 손님은 안내를 못 받은 채로 도착한다.
 */
export async function markExpired(
  sb: SupabaseClient,
  r: SmsReservation,
  kind: SmsKind,
): Promise<boolean> {
  const { error } = await sb
    .from("reservation_sms")
    .insert({ reservation_id: r.id, kind, status: "expired", to_phone: normalizePhone(r.phone) });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return false; // 이미 처리된 건
    throw new Error(`문자 장부 기록 실패: ${error.message}`);
  }

  await notifyExpired({ name: r.name, kind, slot: formatSlot(r), origin: "auto" });
  return true;
}

/**
 * 자동발송은 켜져 있는데 연락처가 없어 못 보낸 것을 남긴다.
 *
 * **`failed`로 적지 않는 이유가 설계의 핵심이다.** `failed`는 유니크 인덱스 밖이라 다음 틱이
 * 곧바로 다시 시도하는데, 연락처가 없는 상태는 사람이 번호를 넣기 전까지 절대 안 풀린다 —
 * 유예 창(입실 안내는 30분) 내내 매 분 같은 실패를 쌓고 채널을 도배한다. `no_phone`은
 * 자리를 막아 한 번만 알린다. 번호를 넣은 뒤 어드민에서 재발송하면 그 행은 `superseded`가 된다.
 */
export async function markNoPhone(
  sb: SupabaseClient,
  r: SmsReservation,
  kind: SmsKind,
): Promise<boolean> {
  const { error } = await sb
    .from("reservation_sms")
    .insert({ reservation_id: r.id, kind, status: "no_phone", body: render(kind, r) });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return false;
    throw new Error(`문자 장부 기록 실패: ${error.message}`);
  }

  await notifyFailed(
    { name: r.name, kind, slot: formatSlot(r), origin: "auto" },
    null,
    "연락처가 없어 자동 발송하지 못했습니다",
  );
  return true;
}

/**
 * 번호가 없어 사람이 직접 보낸 것을 장부에 남긴다.
 *
 * 이 상태가 없으면 '아직 안 보냄'과 '문자 앱으로 보냈음'을 구분할 수 없어, 어드민 화면이
 * 영원히 빨간 채로 남고 결국 아무도 안 보게 된다.
 */
export async function markManual(
  sb: SupabaseClient,
  r: SmsReservation,
  kind: SmsKind,
): Promise<boolean> {
  const { error } = await sb.from("reservation_sms").insert({
    reservation_id: r.id,
    kind,
    status: "manual",
    to_phone: normalizePhone(r.phone),
    body: render(kind, r),
    sent_at: new Date().toISOString(),
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return false;
    throw new Error(`문자 장부 기록 실패: ${error.message}`);
  }
  return true;
}

/**
 * 재발송을 위해 기존 기록을 물러나게 한다.
 *
 * **지우거나 'failed'로 고치지 않는다.** 지우면 '무엇을 언제 보냈나'가 사라지고, 'failed'로
 * 고치면 실제로 나간 문자가 실패로 적힌 거짓말이 된다. `superseded`는 유니크 인덱스 밖이라
 * 자리를 비우면서 이력은 그대로 남는다.
 */
export async function supersede(
  sb: SupabaseClient,
  reservationId: string,
  kind: SmsKind,
): Promise<void> {
  const { error } = await sb
    .from("reservation_sms")
    .update({ status: "superseded" })
    .eq("reservation_id", reservationId)
    .eq("kind", kind)
    .not("status", "in", "(failed,superseded)");

  if (error) throw new Error(`문자 장부 갱신 실패: ${error.message}`);
}
