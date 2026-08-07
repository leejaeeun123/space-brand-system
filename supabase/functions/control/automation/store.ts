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

/** device_id → 하한 미만으로 돌기 시작한 시각. 행이 없으면 = 지금은 정상. */
export async function fetchTempFloorWatch(sb: SupabaseClient): Promise<Map<string, Date>> {
  const { data, error } = await sb.from("device_temp_floor").select("device_id,below_since");
  if (error) throw new Error(`온도 하한 감시 조회 실패: ${error.message}`);
  const out = new Map<string, Date>();
  for (const row of (data ?? []) as Array<{ device_id: string; below_since: string }>) {
    out.set(row.device_id, new Date(row.below_since));
  }
  return out;
}

/** 감시 시작. 이미 있으면 시각을 덮지 않는다 — 덮으면 5분이 영원히 다시 시작된다. */
export async function startTempFloorWatch(
  sb: SupabaseClient,
  deviceId: string,
  now: Date,
): Promise<void> {
  const { error } = await sb
    .from("device_temp_floor")
    .upsert({ device_id: deviceId, below_since: now.toISOString() }, { ignoreDuplicates: true });
  if (error) console.warn("온도 하한 감시 시작 실패", deviceId, error.message);
}

/** 감시 해제 — 정상 온도로 돌아왔거나, 우리가 방금 하한으로 되돌렸을 때. */
export async function clearTempFloorWatch(
  sb: SupabaseClient,
  deviceIds: string[],
): Promise<void> {
  if (!deviceIds.length) return;
  const { error } = await sb.from("device_temp_floor").delete().in("device_id", deviceIds);
  if (error) console.warn("온도 하한 감시 해제 실패", error.message);
}
