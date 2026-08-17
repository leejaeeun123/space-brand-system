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
  /**
   * 문자에만 덧붙일 블록 — 현관·어드민 비밀번호(`cleaning/templates.ts`의 `accessBlock`).
   *
   * **`body`와 나눠 놓은 것이 이 필드의 존재 이유다.** `body`는 세 곳으로 간다:
   * 문자, `cleaning_sms.body` 컬럼, Mattermost 채널. 비밀번호를 `body`에 넣으면
   * 장부에 영구히 남고(비밀번호를 바꿔도 옛 값이 계속 남는다) 채널에도 평문으로 올라간다 —
   * 채널 글은 검색되고 전달되고 잠금화면에 뜬다. 이 레포가 주민번호·계좌번호를 알림에
   * 싣지 않는 것과 같은 이유다.
   *
   * 그래서 이 값은 `send()`에만 들어간다. 장부에도 채널에도 흔적이 남지 않고, 채널에는
   * '접근 안내를 포함해 보냈다'는 사실만 표시된다(`notify.ts`).
   */
  smsOnly?: string;
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
 * 발송·알림 의존성. **테스트가 smsOnly 경계를 3중으로 재기 위해서만 존재한다** —
 * 장부(insert payload)에 비밀번호가 없고, 문자(send text)에는 있고, 실패 알림(error)에는
 * 없다는 것을 진짜 벤더·채널 없이 assert하려면 이 두 함수를 갈아끼울 자리가 필요하다.
 * 프로덕션 호출부는 이 인자를 쓰지 않는다(기본값이 실제 구현).
 */
export interface DispatchDeps {
  send: typeof send;
  notifySent: typeof notifySent;
  notifyFailed: typeof notifyFailed;
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
  deps: DispatchDeps = { send, notifySent, notifyFailed },
): Promise<DispatchStatus> {
  const id = await claim(sb, out, "sending", phone);
  if (id === null) return "already";

  // 비밀번호 블록은 **여기서만** 붙는다. claim(장부)과 notify(채널)는 위아래로 `out.body`를
  // 그대로 보므로, 이 한 줄이 "문자에만 간다"의 전부다.
  const result = await deps.send(cfg, phone, out.smsOnly ? `${out.body}\n\n${out.smsOnly}` : out.body);

  if (result.ok) {
    // 여기서 함수가 죽으면 행이 'sending'에 남아 다음 시도를 막는다 — **안전한 쪽으로 죽는다.**
    // 문자는 이미 나갔으므로, 막히는 것이 두 번 가는 것보다 낫다.
    await sb
      .from("cleaning_sms")
      .update({ status: "sent", sent_at: new Date().toISOString(), group_id: result.groupId })
      .eq("id", id);
    await deps.notifySent(out.kind, out.body, Boolean(out.smsOnly));
    return "sent";
  }

  await sb.from("cleaning_sms").update({ status: "failed", error: result.error }).eq("id", id);
  // 실패 알림에도 비밀번호는 안 싣는다. 형운이 손으로 보낼 때 필요한 값이지만, 형운은 그 값을
  // 이미 알고 있고 — 채널에 남기는 대가가 그 편의보다 크다.
  await deps.notifyFailed(out.kind, out.body, result.error, Boolean(out.smsOnly));
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
