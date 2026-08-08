/**
 * 청소 창 계산 — 단일 책임: 순수 시각 산술. DB도 벤더도 건드리지 않는다.
 *
 * `automation/windows.ts`와 같은 층이고 KST 규약도 그대로 빌려 쓴다. 특히 종료 시각은
 * **반드시 `endTime()`을 통한다** — 직접 `targetTime(date, end_time)`을 쓰면 자정을 넘기는
 * 예약(22:00~02:00)의 종료가 시작보다 이르게 나와 청소 창이 통째로 뒤집힌다(#41과 같은 함정).
 *
 * 계산과 표시를 **두 단계로 나눈 것이 핵심이다**: `planCleaning`은 스케줄만 보고 창을 만들고,
 * `remaining`이 '지금'을 반영해 잘라낸다. 한 번에 하면 오전에 지나간 긴 창이 '10분짜리'로
 * 보여 연달림 경고로 둔갑한다 — 연달림은 스케줄의 성질이지 지금 몇 시인가의 문제가 아니다.
 */

import { endTime, kstDay, targetTime } from "../automation/windows.ts";

/** 이 간격 이상이어야 청소를 할 수 있다고 본다(형운 결정, 2026-08-09). */
export const MIN_CLEANING_MINUTES = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 청소 창 계산에 필요한 최소 필드. 예약 행 전체를 알 필요가 없다. */
export interface CleaningReservation {
  id: string;
  date: string; // 'YYYY-MM-DD' (KST)
  start_time: string; // 'HH:MM:SS' (KST)
  end_time: string;
  name: string;
  guests: number | null;
  purpose: string | null;
}

/**
 * 청소 가능 구간.
 *
 * `from`이 null이면 하루 전체(예약 0건), `to`가 null이면 끝 경계가 없다("20:00 이후").
 * 둘 다 null이 아니면 닫힌 구간이고 `minutes`가 그 길이다.
 */
export interface CleaningWindow {
  from: Date | null;
  to: Date | null;
  minutes: number | null;
}

/** 30분을 못 채운 공백. 창이 아니라 경고로 나간다. */
export interface TightGap {
  afterEnd: Date;
  beforeStart: Date;
  /** 0 이상 `MIN_CLEANING_MINUTES` 미만. 겹친 예약은 음수가 아니라 0으로 본다. */
  minutes: number;
}

export interface CleaningPlan {
  windows: CleaningWindow[];
  tight: TightGap[];
}

function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60000);
}

function later(a: Date, b: Date): Date {
  return a >= b ? a : b;
}

/**
 * 오늘 청소에 영향을 주는 예약만 고른다.
 *
 * `fetchRecent`가 어제~내일을 실어오므로 여기서 좁힌다. **어제 날짜인데 오늘 새벽까지
 * 이어지는 예약을 반드시 포함한다** — 그게 첫 청소 창의 시작을 밀기 때문이다. 빼면
 * "00:00부터 청소 가능"이라고 말하는데 실제로는 02:00까지 손님이 안에 있다.
 */
export function todayReservations<T extends CleaningReservation>(list: T[], now: Date): T[] {
  const today = kstDay(now);
  const dayStart = targetTime(today, "00:00:00");
  return list.filter((r) => {
    if (r.date === today) return true;
    if (r.date > today) return false; // 내일 예약은 오늘 청소와 무관하다
    return endTime(r) > dayStart; // 어제 예약이 오늘 새벽까지 이어진다
  });
}

/** 어제에서 넘어온 예약인가. 목록에 `(어제)`를 붙일지 판단한다. */
export function isCarryOver(r: CleaningReservation, now: Date): boolean {
  return r.date < kstDay(now);
}

/**
 * 스케줄만 보고 청소 창과 연달림 경고를 만든다. **'지금'은 보지 않는다.**
 *
 * 넘어온 예약은 구간을 만들지 않고 첫 경계만 민다 — 그 예약의 앞은 어제 얘기라
 * 오늘 문자가 다룰 일이 아니다.
 */
export function planCleaning(reservations: CleaningReservation[], now: Date): CleaningPlan {
  const today = kstDay(now);
  const dayStart = targetTime(today, "00:00:00");

  const sorted = [...reservations].sort(
    (a, b) => targetTime(a.date, a.start_time).getTime() - targetTime(b.date, b.start_time).getTime(),
  );

  // 예약이 없는 날 — 하루 전체가 창이다. 경계를 비워 "오늘 언제든"으로 적게 한다.
  if (sorted.length === 0) {
    return { windows: [{ from: null, to: null, minutes: null }], tight: [] };
  }

  const windows: CleaningWindow[] = [];
  const tight: TightGap[] = [];
  let cursor = dayStart;

  for (const r of sorted) {
    if (r.date < today) {
      cursor = later(cursor, endTime(r));
      continue;
    }
    const start = targetTime(r.date, r.start_time);
    const gap = minutesBetween(cursor, start);
    if (gap >= MIN_CLEANING_MINUTES) {
      windows.push({ from: cursor, to: start, minutes: gap });
    } else if (cursor > dayStart) {
      // 하루 시작 경계에 붙은 첫 예약(00:20 시작 등)은 '연달림'이 아니다 — 앞 예약이 없다.
      tight.push({ afterEnd: cursor, beforeStart: start, minutes: Math.max(0, gap) });
    }
    cursor = later(cursor, endTime(r));
  }

  // 마지막 퇴실 이후는 끝 경계가 없다.
  windows.push({ from: cursor, to: null, minutes: null });
  return { windows, tight };
}

/**
 * 표시용으로 자른다 — 이미 지난 것을 빼고, 진행 중인 창은 시작을 '지금'으로 당긴다.
 *
 * 당긴 뒤에는 그냥 `from–to`로 적으면 된다. "~13:00 (남은 30분)" 같은 별도 표기를 두지 않는
 * 이유는 `12:30–13:00 (30분)`이 같은 말을 더 짧게 하기 때문이다.
 *
 * **30분 판정을 다시 하지 않는다.** 여기서 재면 오전에 지나간 두 시간짜리 창이 '10분짜리'가
 * 되어 연달림 경고로 둔갑한다. 다만 남은 시간이 30분도 안 되는 창은 **경고로 바꾸지 않고
 * 그냥 뺀다** — 실행할 수 없는 안내를 적으면 문자 전체의 신뢰가 깎인다.
 */
export function remaining(plan: CleaningPlan, now: Date): CleaningPlan {
  const windows: CleaningWindow[] = [];
  for (const w of plan.windows) {
    if (w.from === null) {
      windows.push(w); // 예약 0건 — 경계가 없으니 자를 것도 없다
      continue;
    }
    if (w.to === null) {
      // 마지막 구간. 이미 시작했으면 '지금부터'가 아니라 원래 시각을 유지한다 —
      // "20:00 이후"는 21시에 읽어도 참이고, "21:00 이후"로 바꾸면 매 틱 문구가 흔들린다.
      windows.push(w);
      continue;
    }
    if (w.to <= now) continue; // 이미 끝난 창
    const from = later(w.from, now);
    const left = minutesBetween(from, w.to);
    if (left < MIN_CLEANING_MINUTES) continue;
    windows.push({ from, to: w.to, minutes: left });
  }
  return { windows, tight: plan.tight.filter((g) => g.beforeStart > now) };
}

/** 다음 날로 넘어간 시각인가. 문구에서 `내일 02:00 이후`로 적을지 가른다. */
export function isNextDay(at: Date, now: Date): boolean {
  const dayStart = targetTime(kstDay(now), "00:00:00");
  return at.getTime() >= dayStart.getTime() + DAY_MS;
}
