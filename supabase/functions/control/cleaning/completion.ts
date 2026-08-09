/**
 * 청소 완료 대상 선별 — 단일 책임: 순수 자료 판정. DB도 벤더도 건드리지 않는다.
 *
 * 담당자가 현장에서 QR을 찍으면 "**찍은 시각 이전에 끝난** 예약"이 전부 청소 완료가 된다.
 * 그 '끝났는가'를 정하는 곳이 여기다.
 *
 * ⚠️ **종료 시각은 반드시 `endTime()`을 통한다.** `date`와 `end_time`을 문자열로 비교하면
 * 자정을 넘기는 예약(22:00~02:00)이 00:30 스캔에 '이미 끝난 것'으로 잡힌다 — 손님이 아직
 * 안에 있는데 청소가 끝났다고 장부에 적히고, 그러면 아무도 그 방을 다시 안 본다.
 * #41이 같은 함정이었고 `cleaning/windows.ts`도 같은 이유로 이 규칙을 지킨다.
 *
 * **여기서 예약자 이름·연락처를 다루지 않는 것도 설계다.** QR은 인쇄물이라 사진으로 찍히고
 * 스캐너 앱 기록에 남는다. 그 경로가 개인정보를 읽는 경로가 되면 안 된다 — 호출부가
 * 예약에서 뽑아오는 필드도 여기 적힌 넷이 전부다.
 */

import { endTime, type ReservationWindow } from "../automation/windows.ts";

/** 완료 판정에 필요한 최소 필드. 이름·연락처·인원·용도는 여기 없다. */
export interface CompletableReservation extends ReservationWindow {
  id: string;
}

/** 사람에게 보여줄 요약. 건수와 날짜 범위뿐이고 예약 하나하나를 밝히지 않는다. */
export interface CompletionSummary {
  count: number;
  /** 가장 이른 예약 날짜(KST). 0건이면 null. */
  from: string | null;
  /** 가장 늦은 예약 날짜(KST). 0건이면 null. */
  to: string | null;
}

/**
 * `at` 시점까지 **이미 끝난** 예약만 고른다.
 *
 * 경계는 포함(`<=`)이다. 종료 시각이 정확히 스캔 시각이면 그 예약은 끝난 것이다 —
 * 담당자는 손님이 나간 뒤에 들어와 찍고, 1초 차이로 한 건이 빠지면 그 한 건은 다음
 * 스캔까지 미완료로 남는다.
 *
 * 취소·완료 여부는 **여기서 보지 않는다.** 그건 조회 조건이지 시각 판정이 아니고,
 * 섞으면 이 함수가 무엇을 책임지는지 흐려진다(호출부가 `cancelled`·`cleaning_done`으로 좁힌다).
 */
export function endedBy<T extends CompletableReservation>(list: T[], at: Date): T[] {
  return list.filter((r) => endTime(r) <= at);
}

/**
 * 건수와 날짜 범위로 줄인다.
 *
 * 날짜는 `date` 문자열을 그대로 쓴다 — 자정을 넘기는 예약도 장부상 하루에 속하고,
 * 담당자에게 "8월 3일부터 8월 9일까지"라고 말하는 편이 실제 종료 시각을 말하는 것보다
 * 눈으로 대조하기 쉽다.
 */
export function summarize(list: CompletableReservation[]): CompletionSummary {
  if (list.length === 0) return { count: 0, from: null, to: null };
  const dates = list.map((r) => r.date).sort();
  return { count: list.length, from: dates[0], to: dates[dates.length - 1] };
}
