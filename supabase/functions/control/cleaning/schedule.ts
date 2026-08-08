/**
 * 청소 안내 발송 시각 판정 — 단일 책임: 순수 시각 계산. DB도 벤더도 건드리지 않는다.
 *
 * 손님 문자의 `sms/schedule.ts`와 같은 자리지만 **유예 규칙이 다르다.** 그쪽은 종류마다
 * 짧은 유예(15~60분)를 두는데, "퇴실 15분 남았어요"가 퇴실 뒤에 도착하면 해롭기 때문이다.
 * 청소 안내는 반대다 — 10시에 받아도 남은 청소 창은 그대로 유효하다. 그래서 07:00부터
 * 22:00 전까지면 언제든 보낸다.
 *
 * 고정 60분 유예로 두면 두 곳이 깨진다:
 *   1) 사람이 08시 넘어 재발송하려고 기존 행을 물러나게 해도 다음 틱이 이미 `expired`라 안 나간다.
 *   2) 함수가 07:00~08:01 죽어 있으면 다이제스트가 만료되고, 변경 안내는 '다이제스트가 sent일
 *      때만' 열리므로 그 게이트도 영영 안 열려 **그날 하루가 통째로 침묵한다.**
 */

import { kstDay, targetTime } from "../automation/windows.ts";

/** 아침 다이제스트를 보내는 시각(KST). 형운 결정, 2026-08-09. */
export const DIGEST_HOUR = 7;

/**
 * 이 시각(KST)부터는 문자를 보내지 않는다.
 *
 * 변경 안내의 억제선이자 다이제스트의 만료선이다. 하나로 둔 이유는 둘 다 같은 질문에
 * 답하기 때문이다 — "지금 담당자 폰을 울려도 되는 시간인가".
 */
export const UPDATE_UNTIL_HOUR = 22;

export type DigestState = "wait" | "fire" | "expired";

function atHour(now: Date, hour: number): Date {
  return targetTime(kstDay(now), `${String(hour).padStart(2, "0")}:00:00`);
}

/** 오늘 다이제스트가 나가야 하는 시각. */
export function digestDueAt(now: Date): Date {
  return atHour(now, DIGEST_HOUR);
}

/** 문자를 보내도 되는 시간대가 끝나는 시각. */
export function quietFrom(now: Date): Date {
  return atHour(now, UPDATE_UNTIL_HOUR);
}

/**
 * 지금 다이제스트를 어떻게 해야 하는가.
 *
 * 이미 보냈는지는 **묻지 않는다** — 그건 장부(유니크 인덱스)가 원자적으로 판정한다.
 * 여기서 미리 확인하면 겹친 두 틱이 나란히 통과해 같은 문자를 두 번 보낸다.
 */
export function digestState(now: Date): DigestState {
  if (now < digestDueAt(now)) return "wait";
  return now < quietFrom(now) ? "fire" : "expired";
}

/**
 * 지금 변경 안내를 문자로 보내도 되는가.
 *
 * false여도 **조용히 넘기지 않는다** — 호출부가 `expired` 행으로 남기고 Mattermost에는 올린다.
 * 그래야 기준선이 갱신돼 같은 변경을 다음 틱이 또 감지하는 무한 루프가 끊긴다.
 */
export function updateAllowed(now: Date): boolean {
  return now >= digestDueAt(now) && now < quietFrom(now);
}
