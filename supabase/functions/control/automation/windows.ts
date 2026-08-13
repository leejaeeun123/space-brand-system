/**
 * 예약 자동화의 시각 판정 — 단일 책임: 순수 시각 계산. DB도 기기도 건드리지 않는다.
 *
 * ⚠️ **예약 시각은 KST인데 런타임은 UTC다.** Edge Function(Deno Deploy)의 로컬 타임존은
 * UTC라, 오프셋 없이 `new Date("2026-08-10T14:30:00")`으로 파싱하면 그건 14:30 **UTC**
 * (=23:30 KST)가 된다 — 자동화가 9시간 어긋난 채로 조용히 돌아간다. 개발 맥(KST)에서는
 * 같은 코드가 우연히 맞게 나와서 테스트로도 안 잡힌다(실제로 한 번 이렇게 틀렸다).
 * 그래서 오프셋을 **명시적으로** 붙인다. 한국은 서머타임이 없어 +09:00 고정이 영구히 안전하다.
 */

const KST_OFFSET = "+09:00";
const KST_SHIFT_MS = 9 * 60 * 60 * 1000;

/** 입실 몇 분 전에 냉난방·조명을 준비하는가. */
export const PREP_LEAD_MINUTES = 15;
/** 예정 시각을 이만큼 넘기면 실행하지 않고 건너뛴다 — 밀린 명령의 뒤늦은 재생 방지. */
export const CATCHUP_WINDOW_MINUTES = 10;
/** 퇴실 후 이 시간 동안, 켜지는 기기를 매 틱 다시 끈다. */
export const SWEEP_WINDOW_MINUTES = 10;

/** 시각 판정에 필요한 최소 필드. 예약 행 전체를 알 필요가 없다. */
export interface ReservationWindow {
  date: string; // 'YYYY-MM-DD' (KST)
  start_time: string; // 'HH:MM:SS' (KST)
  end_time: string;
}

/** 'YYYY-MM-DD' + 'HH:MM:SS'(KST) → 그 순간의 Date. */
export function targetTime(date: string, time: string): Date {
  return new Date(`${date}T${time}${KST_OFFSET}`);
}

/** now가 속한 **KST 달력 날짜**. 예약 조회 범위를 좁히는 데 쓴다 —
 *  UTC 날짜로 자르면 KST 00:00~09:00 사이에 어제 날짜로 조회된다. */
export function kstDay(now: Date): string {
  return new Date(now.getTime() + KST_SHIFT_MS).toISOString().slice(0, 10);
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60000;
}

/** 입실 준비를 시작할 시각(= 입실 15분 전). */
export function prepTime(r: ReservationWindow): Date {
  return new Date(targetTime(r.date, r.start_time).getTime() - PREP_LEAD_MINUTES * 60000);
}

/**
 * 퇴실 시각.
 *
 * ⚠️ **자정을 넘기는 예약은 종료가 다음 날이다.** 예약 행은 날짜 하나에 시각 둘을 들고 있어서
 * `18:00~00:00`이나 `22:00~02:00`을 그대로 읽으면 종료가 시작보다 **이르게** 나온다.
 *
 * 2026-08-08에 `18:00~00:00` 예약(8/23)에서 실제로 확인한 결과가 이랬다:
 *   · 8/23 **00:00**(시작 18시간 전)에 퇴실 종료가 돌아 `checkout_automation_at`이 찍힌다
 *     → 진짜 퇴실(8/24 00:00)엔 '이미 했다'고 보고 **아무것도 안 꺼진다.** 냉난방이 밤새 돈다.
 *   · 문자도 같이 어긋나 "퇴실 15분 남았어요"가 **하루 전날 23:45**에 나간다.
 *
 * 그래서 종료가 시작보다 이르거나 같으면 하루를 더한다. 이 판정이 여기 있어야 하는 이유는
 * 기기 자동화와 문자 스케줄이 **같은 함수를 봐야** 두 개가 어긋나지 않기 때문이다.
 */
export function endTime(r: ReservationWindow): Date {
  const start = targetTime(r.date, r.start_time);
  const end = targetTime(r.date, r.end_time);
  return end <= start ? new Date(end.getTime() + 24 * 60 * 60 * 1000) : end;
}

export type DueState = "wait" | "fire" | "expired";

/** target 시각과 now의 관계. wait=아직 · fire=지금 실행 · expired=창을 넘겨 건너뜀. */
export function dueState(target: Date, now: Date): DueState {
  const past = minutesBetween(target, now);
  if (past < 0) return "wait";
  if (past <= CATCHUP_WINDOW_MINUTES) return "fire";
  return "expired";
}

/**
 * 입실 준비 전환의 due 판정 — 일반 `dueState`와 만료 경계가 다르다.
 *
 * 준비는 입실 15분 전(`prepTime`)에 돌지만, 만료 경계를 준비 시각이 아니라 **입실 시각 +
 * 캐치업 창**에 둔다. 당일 즉시 예약이 '입실 5분 전~직후'에 처음 동기화되면 준비 시각은 이미
 * 지났지만 손님 입실 전 시간이 남아 있는데, prep 시각 기준 10분 캐치업으로 판정하면 곧바로
 * `expired`가 되어 준비가 통째로 스킵되고, 채널엔 장애처럼 읽히는 실패가 남는다(입실 전인데도).
 *
 * 그래서 준비 시각이 지났어도 **입실 시각 + 캐치업 창** 안이면 리드타임이 줄어든 채로라도
 * 실행한다. 입실 시각까지 넘겼으면 손님이 이미 한참 이용 중이라, 뒤늦은 준비가 손님이 맞춰둔
 * 값과 싸우므로 그때는 `expired`다. 퇴실 종료는 이 완화가 필요 없다 — 종료 시각이 곧 실행
 * 시각이라 일반 `dueState(endTime, now)`를 그대로 쓴다.
 */
export function checkinDueState(r: ReservationWindow, now: Date): DueState {
  if (now < prepTime(r)) return "wait";
  const deadline = targetTime(r.date, r.start_time).getTime() + CATCHUP_WINDOW_MINUTES * 60000;
  return now.getTime() <= deadline ? "fire" : "expired";
}

/**
 * 준비 중이거나 이용 중인가 — 즉 공간이 '쓰이는 중'인가.
 *
 * 퇴실 스윕을 막는 것도 이 판정이다: 다음 예약의 준비 시각이 이미 지났다면 그 예약을 위해
 * 켠 기기이므로 꺼선 안 된다. 요구사항의 "다음 예약이 바로 있는 경우 제외"가 여기서 나온다.
 */
export function isOccupied(reservations: ReservationWindow[], now: Date): boolean {
  return reservations.some((r) => prepTime(r) <= now && now < endTime(r));
}

/**
 * 퇴실 직후 스윕 창인가.
 *
 * 이용 중이면 무조건 false다 — 붙어 있는 다음 예약의 준비를 스윕이 되돌리면
 * 손님이 들어왔을 때 불이 꺼져 있다.
 */
/**
 * 스윕 창이 시작된 지 몇 분 지났나. 스윕 중이 아니면 null.
 *
 * 창이 끝나갈 때 "아직도 켜져 있다"를 **한 번** 알리기 위해 필요하다 — 매 틱 알리면 시끄럽고,
 * 아예 안 알리면 조명이 밤새 켜져 있어도 채널엔 '퇴실 종료 성공'만 남는다.
 *
 * 예약이 겹쳐 창 안에 끝난 예약이 둘 이상이면 **가장 이른 퇴실**을 창의 시작으로 삼는다
 * (= 경과 분은 Math.max). 호출부가 이 값으로 '이번 창에서 이미 스윕했나'를 조회하므로,
 * 늦은 쪽을 잡으면 조회 범위가 실제 스윕 시작보다 짧아져 **같은 기기를 다시 알린다.**
 * "10분간 껐는데도 켜져 있다"는 경고도 가장 오래 끄고 있던 창을 기준으로 해야 참이다.
 */
export function sweepElapsedMinutes(
  reservations: ReservationWindow[],
  now: Date,
): number | null {
  if (!isSweeping(reservations, now)) return null;
  const elapsed = reservations
    .map((r) => minutesBetween(endTime(r), now))
    .filter((m) => m >= 0 && m < SWEEP_WINDOW_MINUTES);
  return elapsed.length ? Math.max(...elapsed) : null;
}

export function isSweeping(reservations: ReservationWindow[], now: Date): boolean {
  if (isOccupied(reservations, now)) return false;
  return reservations.some((r) => {
    const past = minutesBetween(endTime(r), now);
    return past >= 0 && past < SWEEP_WINDOW_MINUTES;
  });
}
