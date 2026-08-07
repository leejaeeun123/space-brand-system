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
}

export type AutomationColumn = "checkin_automation_at" | "checkout_automation_at";

/**
 * 어제~오늘(KST) 중 취소되지 않은 예약 전부.
 *
 * 이미 자동화가 끝난 예약도 가져온다 — 창 판정(`isOccupied`)은 '실행했는가'가 아니라
 * '지금 쓰이는 중인가'를 물으므로 실행 완료된 예약도 세어야 한다. 여기서 걸러내면
 * 이용 중인 손님 머리 위로 스윕이 돈다.
 */
export async function fetchRecent(sb: SupabaseClient, now: Date): Promise<Reservation[]> {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const { data, error } = await sb
    .from("reservations")
    .select("id,date,start_time,end_time,checkin_automation_at,checkout_automation_at")
    .eq("cancelled", false)
    .gte("date", kstDay(yesterday))
    .lte("date", kstDay(now));
  if (error) throw new Error(`예약 조회 실패: ${error.message}`);
  return (data ?? []) as Reservation[];
}

/**
 * 자동화를 실행했거나 건너뛰었음을 기록한다.
 *
 * `is(column, null)` 조건을 함께 거는 이유: 두 호출이 겹쳐도 먼저 쓴 쪽의 시각이 남는다.
 * 이 실패는 던지지 않고 로그만 남긴다 — 기록에 실패했다고 이미 나간 기기 명령이 되돌아오지
 * 않고, 여기서 던지면 남은 예약들이 통째로 처리되지 못한다.
 */
export async function markAutomated(
  sb: SupabaseClient,
  id: string,
  column: AutomationColumn,
  now: Date,
): Promise<void> {
  const { error } = await sb
    .from("reservations")
    .update({ [column]: now.toISOString() })
    .eq("id", id)
    .is(column, null);
  if (error) console.warn("자동화 기록 실패", id, column, error.message);
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

/** 마지막으로 본 상태를 기록한다 — 다음 틱이 변화를 재는 기준선이 된다. */
export async function saveObservation(
  sb: SupabaseClient,
  deviceId: string,
  power: string | null,
  temp: number | null,
  now: Date,
): Promise<void> {
  // **upsert가 아니라 update + 없을 때만 insert.** upsert로 두면 payload에 없는
  // `below_since`가 보존되는지가 PostgREST의 병합 규칙에 달리는데, 만약 지워진다면
  // observe가 enforce보다 먼저 도는 탓에 매 틱 온도 하한 시계가 리셋돼 **5분이 영원히
  // 안 차고 하한이 통째로 죽는다.** 에러도 로그도 없는 조용한 고장이라, 규칙에 기대지 않고
  // 건드릴 컬럼만 명시하는 update로 확정한다.
  const patch = { last_power: power, last_temp: temp, seen_at: now.toISOString() };
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
