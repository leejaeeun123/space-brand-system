/**
 * 손님 제어 페이지의 시간 게이트 — "예약 시간에만 연다"의 유일한 판정.
 *
 * 손님 role은 비밀번호가 없어(auth.ts) URL만 알면 누구나 요청을 보낼 수 있다. 그래서
 * "언제" 열려 있는지도 서버가 정해야 한다 — 클라이언트 시계를 보고 버튼을 감추는 방식으로는
 * 아무것도 막지 못한다. admin은 이 게이트를 거치지 않는다(index.ts에서 role로 분기).
 * `automate`도 거치지 않는다 — 자동화가 일하는 순간은 정의상 예약 구간 밖이다(index.ts).
 *
 * reservations는 예약자 개인정보(이름·연락처)를 담고 있어 admin_* RPC 뒤에 있고 손님 role로는
 * 못 읽는다. 이 파일만 service_role로 "지금 시각이 예약 구간 안인가"라는 boolean 하나를 뽑아
 * 손님에게 개인정보를 노출하지 않고 판정한다.
 *
 * ⚠️ **판정은 SQL이 아니라 `automation/windows.ts`가 한다.** 예전에는 여기서 `date`·`time`
 * 문자열을 그대로 SQL 비교(`start_time <= now < end_time`)했는데, 그러면 자정을 넘기는 예약
 * (`19:00~00:00`)이 **예약 진행 중에도 항상 거짓**이 된다 — `00:00 > 19:00`이 거짓이라서다.
 * 2026-08-11 한승주 예약(19:00~00:00)에서 손님 페이지가 예약 내내 안 열린 것이 이 경로였다.
 * 기기 자동화·문자·청소는 이미 `endTime()`을 통해 같은 함정을 피하고 있었고(#41), 여기만
 * 따로 SQL로 판정하고 있었다. 판정을 한 함수로 모으는 것이 어긋남을 막는 유일한 방법이다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { endTime, kstDay, type ReservationWindow, targetTime } from "./automation/windows.ts";
import { checkinNoticeAt } from "./sms/schedule.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * 판정에 필요한 예약 행. 조회 실패는 `null`로 돌려 호출부가 **닫는** 쪽을 고르게 한다 —
 * 빈 배열(`[]`)과 섞으면 "예약이 없다"와 "못 읽었다"가 같은 값이 되고, 그 둘은 뜻이 다르다.
 *
 * **어제·오늘·내일 사흘을 읽는다.** `date`는 예약이 시작한 날이라 판정 시각의 날짜와 다를 수 있고,
 * 방향이 양쪽이다:
 *   · 어제 — 자정을 넘긴 예약은 `date`가 어제인 채로 오늘 새벽까지 이어진다(`22:00~02:00`).
 *     오늘 것만 읽으면 그 손님은 01:00에 자기 예약 중인데도 페이지가 닫힌다.
 *   · 내일 — 리드타임이 붙은 판정(`withinGuideWindow`, 입실 10분 전)은 **날짜가 넘어가기 전에**
 *     열려야 한다. `00:00` 시작 예약이라면 열리는 시각이 전날 `23:50`이고, 그때 `kstDay(now)`는
 *     아직 전날이라 그 행이 조회 범위 밖이 된다 — 게이트가 리드타임 10분 내내 닫혀 있다.
 *     0분 리드였던 시절엔 시작 정각에 이미 날짜가 넘어가 있어 드러나지 않던 경계다.
 *
 * 사흘을 읽어도 판정은 시각 비교가 하므로 범위를 넓히는 것 자체로 열리는 예약은 없다.
 */
async function fetchWindows(sb: SupabaseClient, now: Date): Promise<ReservationWindow[] | null> {
  const days = [
    kstDay(new Date(now.getTime() - DAY_MS)),
    kstDay(now),
    kstDay(new Date(now.getTime() + DAY_MS)),
  ];

  const { data, error } = await sb
    .from("reservations")
    .select("date,start_time,end_time")
    .in("date", days)
    .eq("cancelled", false);

  if (error) {
    console.error("예약 시간 조회 실패", error);
    return null;
  }

  return (data ?? []) as ReservationWindow[];
}

/**
 * 취소되지 않은 예약 중 [시작, 종료) 구간에 지금이 들어가는 게 하나라도 있으면 true.
 * end_time은 스클 동기화 시점에 이미 배타적 상한으로 저장된다(예: 16~18시 이용 → end_time 19:00,
 * automation/spacecloud-api-sync.js 참고) — 그래서 종료와의 비교도 배타적(<)이어야 맞다.
 *
 * 조회가 실패하면 **false로 닫는다**. ADMIN_PASSWORD 미설정 시 전면 거부(auth.ts)와 같은 태도 —
 * 반쯤 실패한 채로 손님에게 제어를 열어주는 것보다, 예약 시간에 한 번 더 새로고침하게 하는 쪽이 낫다.
 */
export async function withinReservationWindow(sb: SupabaseClient, now = new Date()): Promise<boolean> {
  const rs = await fetchWindows(sb, now);
  if (!rs) return false;

  return rs.some((r) => targetTime(r.date, r.start_time) <= now && now < endTime(r));
}

/**
 * 이용 안내 페이지(`guest-guide.html`)의 게이트 — **입실 안내 문자와 같은 시각에** 열린다.
 *
 * 안내 페이지는 손님이 문 앞에서 현관 비밀번호를 읽는 화면이라, 제어와 달리 입실 **전에**
 * 열려 있어야 쓸모가 있다. 입실 정각에 열리면 그 순간 문 앞에서 못 들어간다.
 *
 * 그 시각을 여기서 새로 정하지 않고 `checkinNoticeAt`(문자 스케줄)을 본다. **입실 안내 문자가
 * 이 페이지 링크를 싣고 있어서다**(`sms/templates.ts`) — 링크를 받은 손님이 그 자리에서
 * 눌렀을 때 닫혀 있으면 안 된다. 리드타임을 두 곳에 적으면 문자만 앞당겨지고 게이트는 그대로
 * 남는 식으로 어긋난다.
 *
 * 실제 발송은 pg_cron 1분 틱이라 예정 시각과 몇 초~1분 차이가 나는데, 방향이 안전한 쪽이다 —
 * 게이트는 정확히 예정 시각에 열리고 문자는 그 이후에 도착하므로, **문자가 게이트를 앞지르는
 * 경우가 없다.**
 *
 * ⚠️ 기기 준비 시각(`prepTime`, 입실 15분 전)과 **일부러 다르다.** 준비는 앞 예약이 붙어
 * 있으면 앞 손님 퇴실까지 미뤄지는데(`prepDueState`), 안내 값은 앞 손님과 충돌할 게 없어
 * 같이 밀 이유가 없다. 묶으면 앞 예약이 있는 날 손님이 문 앞에서 비밀번호를 못 본다.
 *
 * 실패 시 닫는 태도는 제어와 같다. 다만 닫힘의 대가가 크므로(문 앞에서 비밀번호를 못 본다)
 * 페이지는 이 게이트와 무관하게 **문의 연락처를 항상 보여준다** — 그게 손님의 마지막 경로다.
 */
export async function withinGuideWindow(sb: SupabaseClient, now = new Date()): Promise<boolean> {
  const rs = await fetchWindows(sb, now);
  if (!rs) return false;

  return rs.some((r) => checkinNoticeAt(r) <= now && now < endTime(r));
}
