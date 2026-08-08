/**
 * 자동화 상태 저장소 — 단일 책임: 예약 조회와 자동화 기록의 Postgres 접근.
 *
 * service_role로 붙는다(`devices.ts`와 같은 이유 — RLS 정책이 없어 이 경로만 통한다).
 * 쿼리 문법이 여기 한 군데에 모여 있어야 `schedule.ts`/`enforce.ts`가 판단에만 집중한다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { kstDay } from "./windows.ts";

export interface Reservation {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  checkin_automation_at: string | null;
  checkout_automation_at: string | null;
  // ── 아래는 기기 자동화가 아니라 문자 자동 발송(`sms/schedule.ts`)이 쓴다.
  //    같은 조회에 얹은 이유는 대상 예약 집합이 정확히 같아서다 — 따로 조회하면 두 판정이
  //    서로 다른 예약 목록을 보게 되는 순간이 생긴다.
  name: string;
  phone: string | null;
  deposit_required: boolean;
  sms_auto: boolean;
}

export type AutomationColumn = "checkin_automation_at" | "checkout_automation_at";

/**
 * 어제~내일(KST) 중 취소되지 않은 예약 전부.
 *
 * 이미 자동화가 끝난 예약도 가져온다 — 창 판정(`isOccupied`)은 '실행했는가'가 아니라
 * '지금 쓰이는 중인가'를 물으므로 실행 완료된 예약도 세어야 한다. 여기서 걸러내면
 * 이용 중인 손님 머리 위로 스윕이 돈다.
 *
 * **내일까지 가져오는 이유**는 준비가 입실 15분 전이라 자정 직후 예약의 준비 시각이
 * **전날**이기 때문이다. 오늘까지만 가져오면 23:45~23:59에 그 예약이 안 보이고, 자정을
 * 넘겨 처음 보일 땐 이미 캐치업 창(10분)을 넘겨 `expired`로 지나간다 — 00:00~00:05 시작
 * 예약은 **준비가 통째로 안 됐고**(00:06~00:15는 리드타임이 줄어든 채로 늦게 돌았다),
 * 그 사이 다음 예약이 있다는 사실을 몰라 퇴실 스윕도 안 막혔다.
 */
export async function fetchRecent(sb: SupabaseClient, now: Date): Promise<Reservation[]> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const yesterday = new Date(now.getTime() - DAY_MS);
  const tomorrow = new Date(now.getTime() + DAY_MS);
  const { data, error } = await sb
    .from("reservations")
    // 한 줄 리터럴로 둔다. 문자열을 이어붙이면 supabase-js가 컬럼을 못 읽어내고
    // 반환 타입이 통째로 무너진다(`GenericStringError[]`). 길다고 쪼개지 말 것.
    .select("id,date,start_time,end_time,checkin_automation_at,checkout_automation_at,name,phone,deposit_required,sms_auto")
    .eq("cancelled", false)
    .gte("date", kstDay(yesterday))
    .lte("date", kstDay(tomorrow));
  if (error) throw new Error(`예약 조회 실패: ${error.message}`);
  return (data ?? []) as Reservation[];
}

/**
 * 전환 하나를 **원자적으로 가져온다.** 가져왔으면 true — 이제 실행해도 된다는 뜻이다.
 *
 * 표시를 실행 **뒤**에서 앞으로 옮긴 것이다. 예전 순서는 `읽기 → 비었나 확인 → 실행 → 표시`라,
 * `automate`를 anon key로 누구나 부를 수 있는 이상 두 호출이 나란히 확인을 통과해
 * **입실 준비를 두 번 쏠 수 있었다** — `is(column, null)` 가드는 그저 표시를 멱등하게
 * 만들 뿐 실행을 막지 못한다. 조건이 붙은 update는 행 단위로 원자적이라 경쟁하는 쪽
 * 중 하나만 행을 돌려받는다 — 알림이 `claimPending`으로 중복을 막는 것과 같은 방식이다.
 *
 * 대가는 실행에 실패해도 이미 표시돼 재시도하지 않는다는 것인데, 예전에도 실패 시 표시했으므로
 * 새로 잃은 것은 없다. 대신 그 실패가 조용하지 않도록 호출부가 장부에 남긴다.
 */
export async function claimTransition(
  sb: SupabaseClient,
  id: string,
  column: AutomationColumn,
  now: Date,
): Promise<boolean> {
  const { data, error } = await sb
    .from("reservations")
    .update({ [column]: now.toISOString() })
    .eq("id", id)
    .is(column, null)
    .select("id");
  if (error) {
    // 던지지 않는다 — 여기서 던지면 남은 예약들이 통째로 처리되지 못한다.
    // 이번 틱은 건너뛰고, 캐치업 창(10분)이 남았으면 다음 틱이 다시 잡는다.
    console.warn("자동화 선점 실패", id, column, error.message);
    return false;
  }
  return Boolean(data?.length);
}

/**
 * 자동화가 기기에 대해 기억하는 것.
 *
 * 행이 있다 = 한 번이라도 관측했다는 뜻이지 '하한 미만'이 아니다 — 하한 판정은
 * `belowSince`가 null인지로 한다. (예전엔 행의 존재 자체가 하한 미만을 뜻했는데,
 * 관측 스냅샷이 같은 행에 들어오면서 바뀐다.)
 */
export interface Watch {
  belowSince: Date | null;
  lastPower: string | null;
  lastTemp: number | null;
  seenAt: Date | null;
}

interface WatchRow {
  device_id: string;
  below_since: string | null;
  last_power: string | null;
  last_temp: number | null;
  seen_at: string | null;
}

export async function fetchWatch(sb: SupabaseClient): Promise<Map<string, Watch>> {
  const { data, error } = await sb
    .from("device_watch")
    .select("device_id,below_since,last_power,last_temp,seen_at");
  if (error) throw new Error(`기기 감시 조회 실패: ${error.message}`);

  const out = new Map<string, Watch>();
  for (const r of (data ?? []) as WatchRow[]) {
    out.set(r.device_id, {
      belowSince: r.below_since ? new Date(r.below_since) : null,
      lastPower: r.last_power,
      lastTemp: r.last_temp,
      seenAt: r.seen_at ? new Date(r.seen_at) : null,
    });
  }
  return out;
}

/**
 * 마지막으로 본 상태를 기록한다 — 다음 틱이 변화를 재는 기준선이 된다.
 *
 * **null('모름')로 기준선을 덮지 않는다.** `observe.ts`의 판정이 `prev.lastPower !== null`을
 * 요구하므로, 이상 응답 한 번이 기준선을 null로 만들면 **그다음 진짜 변화 한 건이 통째로
 * 먹힌다** — 끈 것은 안 뜨고 그다음 켜진 것만 뜬다. 못 본 것은 '값이 없다'이지 '값이 바뀌었다'가
 * 아니다. (실제로 이렇게 유실된 사례가 확인된 건 아니고, 2026-08-08 알림 조사 중 로직에서
 * 발견한 결함이다 — 이상 응답 한 번이면 성립하므로 고쳐 둔다.)
 *
 * `seen_at`은 **이 판독값을 벤더가 준 시각**이다 — 틱 시각이 아니다. 호출부가
 * `device_state.updated_at`을 넣어준다. 이 값이 `observe.ts` 대조 창의 시작점이라,
 * 틱 시각을 넣으면 **창이 항상 1분짜리로 좁아져** 고정 120초와 똑같아진다.
 * (2026-08-08 배포 직후 실측으로 발견 — 6대의 `seen_at`이 전부 직전 틱 시각이었고,
 * 그래서 대조 창을 넓힌 수정이 사실상 무용지물이었다.)
 *
 * 같은 이유로 아무것도 못 읽은 틱은 아예 쓰지 않는다 — 기준선도 그 시각도 바뀌지 않았으니까.
 *
 * 한계: power와 temp가 시각 하나를 공유한다. 한쪽만 읽힌 틱에서는 다른 축의 창이 조금
 * 좁아지는데, `observe.ts`가 최소 창을 하한으로 두어 덮는다.
 */
export async function saveObservation(
  sb: SupabaseClient,
  deviceId: string,
  power: string | null,
  temp: number | null,
  readAt: Date,
): Promise<void> {
  if (power === null && temp === null) return;

  // **upsert가 아니라 update + 없을 때만 insert.** upsert로 두면 payload에 없는
  // `below_since`가 보존되는지가 PostgREST의 병합 규칙에 달리는데, 만약 지워진다면
  // observe가 enforce보다 먼저 도는 탓에 매 틱 온도 하한 시계가 리셋돼 **5분이 영원히
  // 안 차고 하한이 통째로 죽는다.** 에러도 로그도 없는 조용한 고장이라, 규칙에 기대지 않고
  // 건드릴 컬럼만 명시하는 update로 확정한다.
  const patch: Record<string, unknown> = { seen_at: readAt.toISOString() };
  if (power !== null) patch.last_power = power;
  if (temp !== null) patch.last_temp = temp;
  const { data, error } = await sb
    .from("device_watch")
    .update(patch)
    .eq("device_id", deviceId)
    .select("device_id");
  if (error) {
    console.warn("관측 기록 실패", deviceId, error.message);
    return;
  }
  if (data?.length) return;

  const { error: insertError } = await sb
    .from("device_watch")
    .upsert({ device_id: deviceId, ...patch }, { onConflict: "device_id", ignoreDuplicates: true });
  if (insertError) console.warn("관측 기록 실패", deviceId, insertError.message);
}

/**
 * 하한 미만 가동 시작. 이미 시계가 돌면 덮지 않는다 — 덮으면 5분이 영원히 다시 시작된다.
 *
 * 행이 없으면 만들어서라도 시작한다. `observe.ts`가 매 틱 모든 기기의 행을 넣어주지만,
 * 그 순서에 기대면 나중에 순서가 바뀌었을 때 **시계가 영원히 안 도는** 조용한 고장이 된다
 * (에러도 안 나고 온도만 안 돌아온다).
 */
export async function startTempFloor(
  sb: SupabaseClient,
  deviceId: string,
  now: Date,
  opts: { force?: boolean } = {},
): Promise<void> {
  // force = 이미 돌던 시계를 지금으로 **민다**(교정 실패 후 백오프). 기본은 안 덮는다 —
  // 덮으면 5분이 영원히 다시 시작돼 하한이 절대 안 걸린다.
  let q = sb.from("device_watch").update({ below_since: now.toISOString() }).eq(
    "device_id",
    deviceId,
  );
  if (!opts.force) q = q.is("below_since", null);
  const { data, error } = await q.select("device_id");
  if (error) {
    console.warn("온도 하한 감시 시작 실패", deviceId, error.message);
    return;
  }
  if (data?.length) return; // 기존 행의 시계를 지금 켜다.

  // 여기까지 왔다 = 행이 없거나 이미 시계가 돌고 있다. 둘을 구분하려고 다시 읽지 않고,
  // 충돌 시 무시하는 insert로 양쪽을 한 번에 처리한다(이미 돈다면 그 시각이 살아남는다).
  const { error: insertError } = await sb
    .from("device_watch")
    .upsert(
      { device_id: deviceId, below_since: now.toISOString() },
      { onConflict: "device_id", ignoreDuplicates: true },
    );
  if (insertError) console.warn("온도 하한 감시 시작 실패", deviceId, insertError.message);
}

/**
 * 시계 해제 — 정상 온도로 돌아왔거나, 꺼졌거나, 우리가 방금 하한으로 되돌렸을 때.
 *
 * 행을 **지우지 않고** below_since만 비운다 — 같은 행에 관측 스냅샷이 들어 있어,
 * 지우면 다음 틱이 기준선을 잃고 모든 변화를 현장 조작으로 오인한다.
 */
export async function clearTempFloor(
  sb: SupabaseClient,
  deviceIds: string[],
): Promise<void> {
  if (!deviceIds.length) return;
  const { error } = await sb
    .from("device_watch")
    .update({ below_since: null })
    .in("device_id", deviceIds);
  if (error) console.warn("온도 하한 감시 해제 실패", error.message);
}
