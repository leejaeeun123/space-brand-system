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
  | "onsite" // 현장 조작 (추론)
  | "idle" // 예약 없이 켜져 있음 (관측만 — 끄지 않는다)
  | "device_offline" // 조명·냉난방 연결 끊김 (관측)
  | "device_recovered" // 조명·냉난방 연결 복구 (관측)
  | "camera_offline" // CCTV 연결 끊김 (관측)
  | "camera_recovered" // CCTV 연결 복구 (관측)
  | "system_error"; // automate 서브시스템 실패 (관측)

/**
 * **우리가 기기에 보낸 명령**인 종류. 현장 조작 대조는 이 목록만 '설명'으로 인정한다.
 *
 * 제외 목록이 아니라 **화이트리스트**인 것이 요점이다. 예전엔 `neq('onsite')`로 뺐는데,
 * 그러면 새 kind가 생길 때마다 아무도 손대지 않아도 '우리 명령' 쪽에 들어간다 — `idle`처럼
 * 명령을 하나도 안 보낸 관측이 상태 변화를 설명해버리면 **진짜 현장 조작이 조용히 묻힌다.**
 * 여기 한 줄 적는 일이 그 판단을 반드시 한 번 거치게 만든다.
 */
export const COMMAND_KINDS: EventKind[] = [
  "prep",
  "shutdown",
  "sweep",
  "temp_floor",
  "remote_admin",
  "remote_guest",
];

export interface EventInput {
  /** null = 특정 기기가 아니라 공간 전체의 사건(전환 만료·전환 자체의 실패). */
  device_id: string | null;
  /** camera_id와 device_id는 배타적 — 최대 하나만 채운다. 둘 다 null = 공간 전체 사건. */
  camera_id?: string | null;
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
    camera_id: event.camera_id ?? null,
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
      camera_id: e.camera_id ?? null,
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
 * 대조용 — `since` 이후 **우리가 기기에 보낸** 명령들.
 *
 * `COMMAND_KINDS`만 가져온다. 현장 조작(onsite)이 빠지는 건 그 결과다 — 우리가 보낸 게
 * 아니므로, 포함하면 한 번 잡힌 현장 조작이 다음 변화를 설명해버려 연속된 조작을 놓친다.
 *
 * 공간 전체 사건(device_id = null)은 어떤 기기의 변화도 설명하지 않는다 — 호출부가 기기별로
 * 대조하므로 null은 자연히 아무 기기와도 안 맞는다.
 */
export async function fetchRecentCommands(
  sb: SupabaseClient,
  since: Date,
): Promise<EventRow[]> {
  const { data, error } = await sb
    .from("device_events")
    .select("id,device_id,at,kind,action,value,status,detail")
    .gte("at", since.toISOString())
    .in("kind", COMMAND_KINDS)
    // 실패한 명령은 기기를 바꾸지 못했으므로 **어떤 변화도 설명할 수 없다.** 이걸 빼지 않으면
    // PAT가 만료된 동안 매 틱 쌓이는 실패 기록이 그 기기를 영원히 '설명됨'으로 만들어,
    // 손님이 리모컨으로 뭘 하든 현장 조작이 한 건도 안 잡힌다.
    .eq("status", "ok");
  if (error) throw new Error(`최근 명령 조회 실패: ${error.message}`);
  return (data ?? []) as EventRow[];
}

/**
 * `since` 이후 이 종류의 사건이 있었던 기기들.
 *
 * "이미 알렸나"·"최근에 사람이 만졌나"를 묻는 곳이 셋이라(스윕 중복 억제, 유휴 경보 중복
 * 억제, 유휴 경보의 사람 면제) 한 함수로 모은다.
 *
 * **판단 근거가 장부인 이유**가 여기 있다. 예전엔 스윕이 `device_watch`의 직전 관측값
 * (`lastPower`)으로 '방금 켜졌는지'를 판단했는데, **전환이 일어난 틱은 관측을 건너뛰므로
 * 그 값이 낡는다** — 퇴실 종료 직후엔 기준선이 '이용 중 켜져 있던 상태' 그대로라, 스윕이
 * 매번 "계속 켜져 있던 것"으로 오판해 **알림이 한 건도 안 나갔다**
 * (2026-08-08 실측으로 발견 — 스윕은 동작했는데 채널에만 안 떴다).
 *
 * 장부는 낡지 않는다 — 있었으면 행이 있고, 없었으면 없다.
 */
export async function fetchActedDevices(
  sb: SupabaseClient,
  kinds: EventKind[],
  since: Date,
): Promise<Set<string>> {
  const { data, error } = await sb
    .from("device_events")
    .select("device_id")
    .in("kind", kinds)
    .gte("at", since.toISOString());
  if (error) {
    // 조회에 실패하면 **알리는 쪽**으로 기운다. 중복 알림은 시끄러울 뿐이지만, 놓친 알림은
    // 조명이 밤새 켜져 있는 걸 아무도 모르게 만든다. 억제 목록으로 쓰든 면제 목록으로 쓰든
    // 빈 집합의 결과는 '한 번 더 알린다'로 같아서, 이 기울기는 두 쓰임 모두에서 안전하다.
    console.warn("장부 조회 실패 — 이번엔 알리는 쪽으로 간다", kinds.join(","), error.message);
    return new Set();
  }
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ device_id: string | null }>) {
    if (r.device_id) out.add(r.device_id);
  }
  return out;
}

/** 이번 스윕 창에서 이미 스윕 명령을 보낸 기기들. */
export function fetchSweptSince(sb: SupabaseClient, since: Date): Promise<Set<string>> {
  return fetchActedDevices(sb, ["sweep"], since);
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
    .select("id,device_id,camera_id,at,kind,action,value,status,detail")
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
    .select("id,device_id,camera_id,at,kind,action,value,status,detail");
  if (error) {
    console.error("이벤트 선점 실패 — 이번 틱은 알리지 않는다", error.message);
    return [];
  }
  // **정렬은 여기서 확정한다.** `update ... returning`의 행 순서는 정의돼 있지 않다
  // (`fetchPending`의 order는 '어느 행을 선점할지'만 고른다). 그런데 `message.ts`의 판단이
  // 거의 전부 순서에 매달려 있다 — 묶음의 대표 시각, "같은 기기는 마지막 명령이 최종 상태",
  // 표 헤더의 시각. 지금까지 맞아 보인 건 갓 넣은 행의 물리 순서가 id 순서와 같았을 뿐이고,
  // 선점→해제로 되돌아온 행과 정리 크론이 회수한 페이지가 그 우연을 깬다.
  //
  // `at`만으로는 부족하다 — `recordMany`는 한 statement라 넣은 행의 `at`이 전부 같다.
  // 같은 시각이면 넣은 순서(id)가 곧 일어난 순서다.
  return sortByOccurrence((data ?? []) as EventRow[]);
}

/**
 * 일어난 순서로 정렬 — `at`이 같으면 넣은 순서(`id`).
 *
 * 따로 뺀 이유는 `claimPending`이 보장하는 것이 정확히 이것이기 때문이다 — DB 없이 검증된다.
 */
export function sortByOccurrence(rows: EventRow[]): EventRow[] {
  return [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
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

/** 대상별 최신 이벤트 하나. `connectivity.ts`가 끊김/복구 전환을 판단하는 근거. */
export interface LatestEvent {
  kind: EventKind;
  at: string;
}

/**
 * `device_id`/`camera_id`별 최신 이벤트(둘 중 지정한 kind만) — 끊김이 지금 새로 생긴 것인지,
 * 이미 알린 채 이어지는 중인지, 방금 복구된 것인지를 가른다.
 *
 * **집합(`fetchActedDevices`)이 아니라 최신 한 건을 쓰는 이유**: 끊김→복구→끊김이 창 안에서
 * 반복되면(플래핑) 두 kind의 집합에 같은 기기가 동시에 들어가 버려, 집합 소속만으로는 두 번째
 * 끊김을 다시 알려야 하는지 알 수 없다. 대상별 마지막 한 건의 kind를 봐야 방향을 안다.
 *
 * 조회 실패는 빈 Map으로 — `fetchActedDevices`와 같은 이유로 **알리는 쪽**으로 기운다(끊김을
 * 놓치는 것이 중복 알림보다 비싸다).
 */
export async function fetchLatestByTarget(
  sb: SupabaseClient,
  kinds: EventKind[],
  column: "device_id" | "camera_id",
  since: Date,
): Promise<Map<string, LatestEvent>> {
  const { data, error } = await sb
    .from("device_events")
    .select(`${column},kind,at`)
    .in("kind", kinds)
    .gte("at", since.toISOString())
    .not(column, "is", null)
    .order("at", { ascending: false });
  if (error) {
    console.warn(`최근 연결 이벤트 조회 실패 — 이번엔 알리는 쪽으로 간다(${column})`, error.message);
    return new Map();
  }
  const out = new Map<string, LatestEvent>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const id = r[column] as string;
    // 내림차순이라 각 대상의 첫 등장이 곧 최신 행이다.
    if (!out.has(id)) out.set(id, { kind: r.kind as EventKind, at: r.at as string });
  }
  return out;
}

/**
 * 대상별로 `since` 이후 이 kind의 이벤트 **수**. 연결 끊김 플래핑 상한 판정용.
 *
 * `fetchLatestByTarget`이 '방향'(새 끊김인가)을 주는 것과 짝이다 — 이건 '얼마나 잦은가'를 준다.
 * 끊김↔복구가 짧은 창 안에서 반복될 때 사이클마다 알림 2건이 무한정 나가는 것을 막으려면,
 * 그 대상이 최근 창에서 이미 몇 번 끊겼는지를 세야 한다. 진짜 장기 장애는 전환이 드물어
 * (첫 끊김 + 60분마다 반복) 이 수가 작게 유지되므로 상한에 닿지 않는다.
 *
 * 조회 실패는 빈 Map으로 — `fetchLatestByTarget`과 같은 이유로 **알리는 쪽**으로 기운다
 * (수가 0이면 상한 억제가 안 걸려 새 끊김이 그대로 알려진다).
 */
export async function countRecentByTarget(
  sb: SupabaseClient,
  kind: EventKind,
  column: "device_id" | "camera_id",
  since: Date,
): Promise<Map<string, number>> {
  const { data, error } = await sb
    .from("device_events")
    .select(column)
    .eq("kind", kind)
    .gte("at", since.toISOString())
    .not(column, "is", null);
  if (error) {
    console.warn(`끊김 빈도 조회 실패 — 이번엔 상한을 걸지 않는다(${column})`, error.message);
    return new Map();
  }
  const out = new Map<string, number>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const id = r[column] as string;
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** 같은 `kind`·`action`의 가장 최근 행 하나. `recordSystemError`의 재알림 간격 판단 근거. */
export async function fetchLatestByAction(
  sb: SupabaseClient,
  kind: EventKind,
  action: string,
  since: Date,
): Promise<EventRow | null> {
  const { data, error } = await sb
    .from("device_events")
    .select("id,device_id,camera_id,at,kind,action,value,status,detail")
    .eq("kind", kind)
    .eq("action", action)
    .gte("at", since.toISOString())
    .order("at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("최근 시스템 오류 조회 실패 — 이번엔 알리는 쪽으로 간다", action, error.message);
    return null;
  }
  return data as EventRow | null;
}

/** 같은 원인이 이 시간 안에 이미 알려졌으면 재알림을 참는다. */
const SYSTEM_ERROR_BACKOFF_MINUTES = 15;

/**
 * `automate`의 서브시스템(관측·문자·청소·알림)이 삼켰던 예외를 장부에 남긴다.
 *
 * **같은 서브시스템(action)의 오류가 이미 backoff 창 안에 있으면 원인 문구와 무관하게
 * 조용히 넘어간다.** 온도 하한 강제가 겪은 사고(`enforce.ts`의 주석 — 만료된 PAT 하나가
 * 3시간 예약 동안 175건을 남겼다)가 여기서도 재현될 수 있다.
 *
 * 원인 문자열이 같을 때만 억제하는 방식은 처음엔 "다른 문제면 즉시 알린다"는 장점처럼
 * 보였지만, 벤더 에러 메시지에 요청 ID·소요 시간처럼 매번 바뀌는 값이 섞여 있으면(예: Solapi)
 * 문자열이 절대 같아지지 않아 **매 틱 알리는 최악의 경우**로 조용히 퇴화한다. 그래서
 * `enforce.ts`의 5분 backoff(온도 하한 재시도)와 같은 태도로, 무조건 억제한다.
 */
export async function recordSystemError(
  sb: SupabaseClient,
  action: string,
  detail: string,
  now: Date,
): Promise<void> {
  const since = new Date(now.getTime() - SYSTEM_ERROR_BACKOFF_MINUTES * 60_000);
  const latest = await fetchLatestByAction(sb, "system_error", action, since);
  if (latest) return; // 이 서브시스템의 오류가 아직 대기 창 안 — 원인이 달라졌어도 조용히 넘어간다
  await record(sb, { device_id: null, camera_id: null, kind: "system_error", action, status: "ok", value: detail });
}
