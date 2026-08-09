/**
 * 손님 제어 페이지의 시간 게이트 — "예약 시간에만 연다"의 유일한 판정.
 *
 * 손님 role은 비밀번호가 없어(auth.ts) URL만 알면 누구나 요청을 보낼 수 있다. 그래서
 * "언제" 열려 있는지도 서버가 정해야 한다 — 클라이언트 시계를 보고 버튼을 감추는 방식으로는
 * 아무것도 막지 못한다. admin은 이 게이트를 거치지 않는다(index.ts에서 role로 분기).
 *
 * reservations는 예약자 개인정보(이름·연락처)를 담고 있어 admin_* RPC 뒤에 있고 손님 role로는
 * 못 읽는다. 이 파일만 service_role로 "지금 시각이 예약 구간 안인가"라는 boolean 하나를 뽑아
 * 손님에게 개인정보를 노출하지 않고 판정한다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * UTC now → KST(UTC+9, 한국은 DST 없음) 기준 날짜·시각 문자열.
 * reservations.date/start_time/end_time은 spacecloud 동기화가 KST 벽시계 값을 그대로
 * 넣은 naive 컬럼이라(automation/spacecloud-api-sync.js), 여기서도 naive KST로 맞춘다.
 */
export function kstParts(now: Date): { date: string; time: string } {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return { date: kst.toISOString().slice(0, 10), time: kst.toISOString().slice(11, 19) };
}

/**
 * 취소되지 않은 예약 중 [start_time, end_time) 구간에 지금이 들어가는 게 하나라도 있으면 true.
 * end_time은 스클 동기화 시점에 이미 배타적 상한으로 저장된다(예: 16~18시 이용 → end_time 19:00,
 * automation/spacecloud-api-sync.js 참고) — 그래서 end_time과의 비교도 배타적(<)이어야 맞다.
 *
 * 조회가 실패하면 **false로 닫는다**. ADMIN_PASSWORD 미설정 시 전면 거부(auth.ts)와 같은 태도 —
 * 반쯤 실패한 채로 손님에게 제어를 열어주는 것보다, 예약 시간에 한 번 더 새로고침하게 하는 쪽이 낫다.
 */
export async function withinReservationWindow(sb: SupabaseClient, now = new Date()): Promise<boolean> {
  const { date, time } = kstParts(now);
  const { data, error } = await sb
    .from("reservations")
    .select("id")
    .eq("date", date)
    .eq("cancelled", false)
    .lte("start_time", time)
    .gt("end_time", time)
    .limit(1);
  if (error) {
    console.error("예약 시간 조회 실패", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
