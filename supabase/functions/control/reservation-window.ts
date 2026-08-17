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
 * 이용 안내 페이지(`guest-guide.html`)의 게이트 판정 결과.
 *
 * `open` 하나로는 부족해서 갈랐다. 게이트는 입실 10분 전에 열리는데, 예약이 연달아 붙은 날은
 * 그 10분이 **앞 손님의 마지막 10분**이다. 페이지가 열리는 것 자체는 문제가 없지만(오시는 길·
 * 이용법·와이파이는 미리 봐야 쓸모가 있다), 현관 비밀번호는 물리적 입장 권한이라 그 겹침 동안
 * 내려주면 다음 손님이 앞 손님 이용 중에 문을 열 수 있다(형운 결정, 2026-08-18). 그래서
 * **비밀번호만** 앞 이용이 끝날 때까지 따로 지연한다 — 기기 준비가 앞 예약에 밀리는 것
 * (`prepDueState`)과 같은 이유, 같은 모양이다.
 *
 * 값이 고정 비밀번호라 지연이 막는 것은 '결심한 조기 입장'이 아니라 **악의 없는 조기 입장**
 * (문자를 받고 바로 와서 열어보는 손님)이다 — 과거에 예약했던 사람은 이미 값을 안다. 그 한계를
 * 알고 두는 장치다.
 */
export interface GuideGate {
  open: boolean;
  /** 현관 비밀번호를 이번 응답에서 뺄 것인가 — 앞 예약이 아직 이용 중인 리드타임에만 true. */
  pinWithheld: boolean;
  /** 비밀번호가 열리는 시각(KST "HH:MM"). pinWithheld일 때만 값이 있다. */
  pinAvailableAtKst: string | null;
}

const GATE_CLOSED: GuideGate = { open: false, pinWithheld: false, pinAvailableAtKst: null };

/**
 * 이용 안내 페이지의 게이트 — **입실 안내 문자와 같은 시각에** 열린다.
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
 * 비밀번호 지연 판정은 시각만 본다: 지금이 어떤 예약의 리드타임(문자 시각~시작 전)이고 **동시에**
 * 다른 예약의 이용 구간([시작, 종료))이 진행 중이면 뺀다. 호출자가 앞 손님인지 다음 손님인지는
 * 서버가 알 수 없지만 상관없다 — 앞 손님은 이미 그 비밀번호로 들어와 있고, 겹침이 끝나는 순간
 * (앞 예약 종료 = 대개 다음 예약 시작) 값이 바로 열린다.
 *
 * 실패 시 닫는 태도는 제어와 같다. 다만 닫힘의 대가가 크므로(문 앞에서 비밀번호를 못 본다)
 * 페이지는 이 게이트와 무관하게 **문의 연락처를 항상 보여준다** — 그게 손님의 마지막 경로다.
 */
export async function guideGate(sb: SupabaseClient, now = new Date()): Promise<GuideGate> {
  const rs = await fetchWindows(sb, now);
  if (!rs) return GATE_CLOSED;

  const open = rs.some((r) => checkinNoticeAt(r) <= now && now < endTime(r));
  if (!open) return GATE_CLOSED;

  // 지금이 어떤 예약의 리드타임인가(아직 시작 전) + 다른 예약이 이용 중인가.
  const leadPending = rs.some((r) => checkinNoticeAt(r) <= now && now < targetTime(r.date, r.start_time));
  const occupying = rs.filter((r) => targetTime(r.date, r.start_time) <= now && now < endTime(r));

  if (!leadPending || occupying.length === 0) {
    return { open: true, pinWithheld: false, pinAvailableAtKst: null };
  }

  // 이용 중인 예약이 여럿(데이터 이상)이면 가장 늦게 끝나는 쪽 — 실제로 사람이 나가는 시각이다.
  const until = new Date(Math.max(...occupying.map((r) => endTime(r).getTime())));
  return { open: true, pinWithheld: true, pinAvailableAtKst: kstParts(until).time.slice(0, 5) };
}

/** 게이트의 열림 여부만 필요한 곳을 위한 축약. 판정은 `guideGate` 한 곳이다. */
export async function withinGuideWindow(sb: SupabaseClient, now = new Date()): Promise<boolean> {
  return (await guideGate(sb, now)).open;
}
