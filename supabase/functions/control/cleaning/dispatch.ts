/**
 * 청소 안내 한 통을 실제로 내보내는 유일한 경로.
 *
 * 순서가 곧 안전장치다: **선점 → 발송 → 기록 → 알림.** 선점을 발송 뒤로 옮기면 겹친 두 틱이
 * 같은 문자를 두 번 보낸다(`automate`는 anon key로 누구나 부를 수 있다). `sms/dispatch.ts`·
 * `automation/store.claimTransition`과 같은 이유다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { send } from "../sms/solapi.ts";
import type { SolapiConfig } from "../sms/solapi.ts";
import type { ScheduleSnapshot } from "./diff.ts";
import { type CleaningKind, notifyFailed, notifyQuiet, notifySent } from "./notify.ts";

/** Postgres unique_violation. 선점에 진 쪽이 받는 신호다. */
const UNIQUE_VIOLATION = "23505";

export type DispatchStatus = "sent" | "failed" | "already";

/** 보낼 것 한 벌. 문구와 스냅샷이 짝이라 따로 넘기지 않는다. */
export interface Outgoing {
  kind: CleaningKind;
  /** KST 달력 날짜 'YYYY-MM-DD'. 이 문자가 말하는 날이다. */
  date: string;
  body: string;
  snapshot: ScheduleSnapshot;
  /** update만 쓴다. digest는 날짜로 이미 갈린다. */
  fingerprint: string | null;
}

/** 그 날짜에 대해 마지막으로 '말한' 스케줄. 다음 변경을 재는 기준선이다.
 *
 * `failed`·`sending`은 기준선이 되지 못한다 — 담당자가 못 받은 내용을 '이미 안다'고 치면
 * 그 변경이 영영 안 알려진다. */
export async function latestSnapshot(
  sb: SupabaseClient,
  date: string,
): Promise<ScheduleSnapshot | null> {
  const { data, error } = await sb
    .from("cleaning_sms")
    .select("snapshot")
    .eq("date", date)
    .in("status", ["sent", "expired"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`청소 문자 장부 조회 실패: ${error.message}`);
  return (data?.snapshot as ScheduleSnapshot | undefined) ?? null;
}

/** 그날 다이제스트가 실제로 나갔는가. 변경 안내는 이게 참일 때만 의미가 있다. */
export async function digestSent(sb: SupabaseClient, date: string): Promise<boolean> {
  const { data, error } = await sb
    .from("cleaning_sms")
    .select("id")
    .eq("date", date)
    .eq("kind", "digest")
    .eq("status", "sent")
    .limit(1);
  if (error) throw new Error(`청소 문자 장부 조회 실패: ${error.message}`);
  return Boolean(data?.length);
}

/** 자리를 잡는다. `null`이면 다른 틱이 이미 가져갔다는 뜻이다. */
async function claim(
  sb: SupabaseClient,
  out: Outgoing,
  status: "sending" | "expired",
  phone: string | null,
): Promise<number | null> {
  const { data, error } = await sb
    .from("cleaning_sms")
    .insert({
      date: out.date,
      kind: out.kind,
      status,
      to_phone: phone,
      body: out.body,
      snapshot: out.snapshot,
      fingerprint: out.fingerprint,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return null;
    throw new Error(`청소 문자 장부 기록 실패: ${error.message}`);
  }
  return data.id as number;
}

/**
 * 한 통 보낸다.
 *
 * 실패해도 예외를 던지지 않는다 — 스윕이 여기서 넘어지면 그 뒤 흐름이 통째로 멈춘다.
 * 다만 **장부 기록 자체가 실패하면 던진다.** 그건 '문자가 실패했다'가 아니라 '무엇이
 * 나갔는지 더 이상 모른다'는 뜻이라, 조용히 계속 보내면 안 된다.
 */
export async function dispatch(
  sb: SupabaseClient,
  cfg: SolapiConfig,
  phone: string,
  out: Outgoing,
): Promise<DispatchStatus> {
  const id = await claim(sb, out, "sending", phone);
  if (id === null) return "already";

  const result = await send(cfg, phone, out.body);

  if (result.ok) {
    // 여기서 함수가 죽으면 행이 'sending'에 남아 다음 시도를 막는다 — **안전한 쪽으로 죽는다.**
    // 문자는 이미 나갔으므로, 막히는 것이 두 번 가는 것보다 낫다.
    await sb
      .from("cleaning_sms")
      .update({ status: "sent", sent_at: new Date().toISOString(), group_id: result.groupId })
      .eq("id", id);
    await notifySent(out.kind, out.body);
    return "sent";
  }

  await sb.from("cleaning_sms").update({ status: "failed", error: result.error }).eq("id", id);
  await notifyFailed(out.kind, out.body, result.error);
  return "failed";
}

/**
 * 문자를 보내지 않는 시간대(22시 이후)에 걸린 것을 장부에 남기고 채널에만 올린다.
 *
 * **`expired` 행에도 스냅샷을 채우는 것이 핵심이다.** 그래야 기준선이 전진해, 같은 변경을
 * 다음 틱이 또 감지하는 무한 루프가 끊긴다. 조용히 넘기면 매 틱 같은 diff가 다시 나온다.
 */
export async function markQuiet(sb: SupabaseClient, out: Outgoing): Promise<boolean> {
  const id = await claim(sb, out, "expired", null);
  if (id === null) return false;
  await notifyQuiet(out.kind, out.body);
  return true;
}
