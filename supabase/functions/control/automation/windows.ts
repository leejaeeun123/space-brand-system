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

/** 퇴실 시각. */
export function endTime(r: ReservationWindow): Date {
  return targetTime(r.date, r.end_time);
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
