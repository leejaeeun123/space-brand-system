/**
 * 문자 발송 시각 판정 — 단일 책임: 순수 시각 계산. DB도 벤더도 건드리지 않는다.
 *
 * 기기 자동화의 `automation/windows.ts`와 같은 자리에 있는 층이고, KST 규약도 그대로 빌려 쓴다
 * (`targetTime`이 `+09:00`을 명시적으로 붙인다 — 런타임이 UTC라 안 붙이면 9시간 어긋난다).
 *
 * **여기서 다루는 것은 시각 기반 세 통뿐이다.** 보증금 안내·예약 확정은 '예약이 접수된 시점'에
 * 나가야 하는 문자라 시각으로 계산할 수 없고, 어드민이 자동발송을 켜는 순간
 * `handlers/sms.ts`가 그 자리에서 보낸다.
 */

import { endTime, targetTime } from "../automation/windows.ts";
import type { SmsKind } from "./templates.ts";

/** 시각을 어디에 붙여 재는가. 입실 기준과 퇴실 기준이 섞이므로 명시한다. */
type Anchor = "start" | "end";

interface Timing {
  kind: SmsKind;
  anchor: Anchor;
  /** 기준 시각으로부터 몇 분(음수 = 전). */
  offsetMinutes: number;
  /**
   * 이 시간까지는 늦게라도 보낸다. 넘기면 안 보낸다.
   *
   * 유예가 종류마다 다른 것이 핵심이다 — 입실 안내는 20분 늦어도 쓸모가 있지만,
   * "퇴실 15분 남았어요"가 퇴실 시각 뒤에 도착하면 손님을 혼란스럽게 할 뿐이다.
   */
  graceMinutes: number;
}

/**
 * 문구가 약속하는 시각과 여기 숫자가 **같아야 한다.**
 * `checkin`은 "10분 후 입실 가능하십니다", `checkout_soon`은 "15분 남았어요"라고 적혀 있다.
 * 한쪽만 고치면 손님이 받는 문자와 실제가 어긋난다.
 */
const TIMINGS: readonly Timing[] = [
  { kind: "checkin", anchor: "start", offsetMinutes: -10, graceMinutes: 30 },
  { kind: "checkout_soon", anchor: "end", offsetMinutes: -15, graceMinutes: 15 },
  { kind: "checkout", anchor: "end", offsetMinutes: 0, graceMinutes: 60 },
] as const;

/** 시각 판정에 필요한 최소 필드. */
export interface ScheduleWindow {
  date: string; // 'YYYY-MM-DD' (KST)
  start_time: string; // 'HH:MM:SS' (KST)
  end_time: string;
}

/**
 * 퇴실 기준 시각은 **반드시 `windows.endTime`을 통한다.** 직접 `targetTime(date, end_time)`을
 * 쓰면 자정을 넘기는 예약(18:00~00:00)에서 종료가 시작보다 이르게 나와, 퇴실 안내가
 * **하루 전날** 나간다. 기기 자동화와 같은 함수를 봐야 둘이 어긋나지 않는다.
 */
export function dueAt(r: ScheduleWindow, timing: Timing): Date {
  const base = timing.anchor === "start" ? targetTime(r.date, r.start_time) : endTime(r);
  return new Date(base.getTime() + timing.offsetMinutes * 60000);
}

/**
 * 입실 안내 문자가 나가는 시각.
 *
 * **이용 안내 페이지의 게이트가 이 값을 본다**(`reservation-window.ts`). 그 문자가 안내 페이지
 * 링크를 싣고 있어서다 — 링크를 받은 손님이 눌렀을 때 페이지가 닫혀 있으면 안 된다. 리드타임
 * 숫자를 여기(`TIMINGS`) 한 곳에만 두면 문자 시각을 바꿀 때 게이트가 저절로 따라온다.
 *
 * 기기 준비 시각(`windows.prepTime`, 입실 15분 전)과는 **일부러 다르다.** 준비는 앞 예약이
 * 붙어 있으면 정각으로 밀리지만(`prepDueState`), 안내 값은 앞 손님과 충돌할 게 없어 밀 이유가
 * 없다. 두 시각을 하나로 묶으면 앞 예약이 있는 날 손님이 문 앞에서 비밀번호를 못 본다.
 */
export function checkinNoticeAt(r: ScheduleWindow): Date {
  const checkin = TIMINGS.find((t) => t.kind === "checkin");
  if (!checkin) throw new Error("checkin 타이밍이 TIMINGS에 없습니다");
  return dueAt(r, checkin);
}

export type SmsDueState = "wait" | "fire" | "expired";

export function stateOf(r: ScheduleWindow, timing: Timing, now: Date): SmsDueState {
  const elapsedMinutes = (now.getTime() - dueAt(r, timing).getTime()) / 60000;
  if (elapsedMinutes < 0) return "wait";
  return elapsedMinutes <= timing.graceMinutes ? "fire" : "expired";
}

export interface SchedulePlan {
  /** 지금 보낼 것. */
  fire: SmsKind[];
  /** 창을 놓친 것. 조용히 버리지 않고 장부와 채널에 남긴다. */
  expired: SmsKind[];
}

/**
 * 이 예약에서 지금 무엇을 해야 하는가.
 *
 * 이미 보냈는지는 **묻지 않는다** — 그건 장부(유니크 인덱스)가 원자적으로 판정한다.
 * 여기서 미리 확인하면 겹친 두 호출이 나란히 통과해 같은 문자를 두 번 보낸다.
 */
export function plan(r: ScheduleWindow, now: Date): SchedulePlan {
  const result: SchedulePlan = { fire: [], expired: [] };
  for (const timing of TIMINGS) {
    const state = stateOf(r, timing, now);
    if (state === "fire") result.fire.push(timing.kind);
    else if (state === "expired") result.expired.push(timing.kind);
  }
  return result;
}
