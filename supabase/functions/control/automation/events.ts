/**
 * 조작 이벤트 장부 — 단일 책임: 무슨 일이 있었는지 적고, 아직 안 알린 것을 꺼낸다.
 *
 * 이 장부는 알림의 재료이자 **현장 조작 판별의 기준**이다. 관측된 상태 변화를 여기 적힌
 * 명령과 대조해, 설명되지 않고 남는 변화를 현장 조작으로 본다(→ `observe.ts`).
 * 그래서 기록이 새면 우리가 켠 것을 "현장에서 누가 켰다"고 잘못 알리게 된다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** 무슨 일이었나. 알림의 제목이 여기서 나온다. */
export type EventKind =
  | "prep" // 입실 준비 (자동)
  | "shutdown" // 퇴실 종료 (자동)
  | "sweep" // 퇴실 후 정리 (자동)
  | "temp_floor" // 온도 하한 강제 (자동)
  | "remote_admin" // 어드민이 원격에서
  | "remote_guest" // 손님이 /control에서
  | "onsite"; // 현장 조작 (추론)

export const AUTO_KINDS: EventKind[] = ["prep", "shutdown", "sweep", "temp_floor"];

export interface EventInput {
  device_id: string;
  kind: EventKind;
  action: string;
  value?: string | null;
  status: "ok" | "failed";
  detail?: string | null;
  /**
   * 장부에는 남기되 알림은 보내지 않는다 — `notified_at`을 미리 채워 '이미 알린 것'으로 낳는다.
   *
   * 기록 자체를 건너뛰면 안 된다. 장부에 없는 명령이 만든 상태 변화는 다음 틱이
   * **현장 조작으로 둔갑**시킨다. 조용히 해야 할 것은 알림이지 기록이 아니다.
   */
  silent?: boolean;
}

export interface EventRow extends Required<Omit<EventInput, "value" | "detail" | "silent">> {
  id: number;
  at: string;
  value: string | null;
  detail: string | null;
}

/**
 * 이벤트 1건 기록. **절대 던지지 않는다.**
 *
 * 장부 기록이 실패했다고 이미 나간 기기 명령이 되돌아오지 않고, 여기서 던지면 성공한 제어가
 * 실패로 보인다. 다만 조용히 넘기지는 않는다 — 기록이 빠지면 그 변화가 나중에 현장 조작으로
 * 잘못 잡히므로, 로그에는 반드시 남긴다.
 */
export async function record(sb: SupabaseClient, event: EventInput): Promise<void> {
  const { error } = await sb.from("device_events").insert({
    device_id: event.device_id,
    kind: event.kind,
    action: event.action,
    value: event.value ?? null,
    status: event.status,
    detail: event.detail ?? null,
    notified_at: event.silent ? new Date().toISOString() : null,
  });
  if (error) {
    console.error("이벤트 기록 실패 — 이 변화가 현장 조작으로 오인될 수 있다", event, error.message);
  }
}

/** 여러 건 한 번에. 한 번의 전환이 명령 여러 개를 낳으므로 왕복을 아낀다. */
export async function recordMany(sb: SupabaseClient, events: EventInput[]): Promise<void> {
  if (!events.length) return;
  const { error } = await sb.from("device_events").insert(
    events.map((e) => ({
      device_id: e.device_id,
      kind: e.kind,
      action: e.action,
      value: e.value ?? null,
      status: e.status,
      detail: e.detail ?? null,
      notified_at: e.silent ? new Date().toISOString() : null,
    })),
  );
  if (error) console.error("이벤트 다건 기록 실패", error.message);
}

/**
 * 대조용 — 최근 N초 안에 **우리가** 보낸 명령들.
 *
 * 현장 조작(onsite)은 우리가 보낸 게 아니므로 제외한다. 포함하면 한 번 잡힌 현장 조작이
 * 다음 변화를 설명해버려 연속된 조작을 놓친다.
 */
export async function fetchRecentCommands(
  sb: SupabaseClient,
  since: Date,
): Promise<EventRow[]> {
  const { data, error } = await sb
    .from("device_events")
    .select("id,device_id,at,kind,action,value,status,detail")
    .gte("at", since.toISOString())
    .neq("kind", "onsite")
    // 실패한 명령은 기기를 바꾸지 못했으므로 **어떤 변화도 설명할 수 없다.** 이걸 빼지 않으면
    // PAT가 만료된 동안 매 틱 쌓이는 실패 기록이 그 기기를 영원히 '설명됨'으로 만들어,
    // 손님이 리모컨으로 뭘 하든 현장 조작이 한 건도 안 잡힌다.
    .eq("status", "ok");
  if (error) throw new Error(`최근 명령 조회 실패: ${error.message}`);
  return (data ?? []) as EventRow[];
}

/**
 * 아직 알리지 않은 것. 틱이 이걸 모아 한 건으로 보낸다.
 *
 * **상한을 둔다.** 웹훅이 오래 죽어 있다 살아나면 수천 건이 한 메시지가 되고, 그건 길이로
 * 거절당해 또 안 보내지고, 다음 틱에 같은 크기가 다시 만들어져 **영원히 못 빠져나온다.**
 * 잘라 보내면 여러 틱에 걸쳐서라도 소진된다.
 */
const PENDING_LIMIT = 200;

export async function fetchPending(sb: SupabaseClient): Promise<EventRow[]> {
  const { data, error } = await sb
    .from("device_events")
    .select("id,device_id,at,kind,action,value,status,detail")
    .is("notified_at", null)
    .order("at", { ascending: true })
    .limit(PENDING_LIMIT);
  if (error) throw new Error(`미발송 이벤트 조회 실패: ${error.message}`);
  return (data ?? []) as EventRow[];
}

/**
 * 보내기 **전에** 선점한다 — `notified_at`을 먼저 찍고, 실제로 찍힌 행만 돌려준다.
 *
 * `automate`는 anon key로 누구나 부를 수 있어(`auth.ts`) 두 호출이 겹칠 수 있다. 보낸 뒤에
 * 표시하면 둘 다 같은 행을 읽어 **같은 알림이 두 번** 간다. `is("notified_at", null)`
 * 조건이 붙은 update는 행 단위로 원자적이라, 경쟁하는 호출 중 하나만 그 행을 가져간다.
 *
 * 대가는 방향이 바뀐 것이다 — 발송에 실패하면 `release()`로 되돌리지만, 그 사이에 함수가
 * 죽으면 그 이벤트는 알려지지 않는다. 중복을 막는 대신 아주 드문 유실을 받아들인 선택이다
 * (형운 결정, 2026-08-07).
 */
export async function claimPending(sb: SupabaseClient, now: Date): Promise<EventRow[]> {
  const pending = await fetchPending(sb);
  if (!pending.length) return [];

  const { data, error } = await sb
    .from("device_events")
    .update({ notified_at: now.toISOString() })
    .in("id", pending.map((e) => e.id))
    .is("notified_at", null)
    .select("id,device_id,at,kind,action,value,status,detail");
  if (error) {
    console.error("이벤트 선점 실패 — 이번 틱은 알리지 않는다", error.message);
    return [];
  }
  return (data ?? []) as EventRow[];
}

/** 발송에 실패한 선점을 되돌린다 — 다음 틱이 다시 시도한다. */
export async function release(sb: SupabaseClient, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await sb
    .from("device_events")
    .update({ notified_at: null })
    .in("id", ids);
  if (error) console.error("선점 해제 실패 — 이 알림은 유실된다", ids.length, error.message);
}
