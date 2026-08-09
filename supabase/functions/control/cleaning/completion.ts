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
 * **이름은 싣고 연락처는 안 싣는다.** 담당자에게는 아침 다이제스트 문자가 이미 예약자
 * 이름·인원·용도를 보내고 있고(내부 인력이라는 판단 — `cleaning/templates.ts`, 형운 확인
 * 2026-08-09), 이 화면에서도 "언제 누구 예약을 완료 처리하는가"가 보여야 담당자가 눈으로
 * 대조할 수 있다(형운 결정, 2026-08-09). 다만 **연락처·이메일은 끝까지 안 읽는다** — 대조에
 * 쓸모가 없고, QR은 인쇄물이라 사진으로 찍히고 스캐너 앱 기록에 남는다.
 */

import { endTime, targetTime, type ReservationWindow } from "../automation/windows.ts";

/** 완료 판정과 표시에 필요한 최소 필드. 연락처·이메일·금액은 여기 없다. */
export interface CompletableReservation extends ReservationWindow {
  id: string;
  name: string;
}

/** 화면과 알림에 한 줄로 나가는 예약. */
export interface CompletionEntry {
  id: string;
  /** 'YYYY-MM-DD' (KST). 시작한 날이다. */
  date: string;
  start: string; // 'HH:MM'
  end: string;
  /** 종료가 다음 날인가. 22:00–02:00을 그냥 적으면 읽는 사람이 거꾸로 읽는다. */
  crossesMidnight: boolean;
  name: string;
}

/** 사람에게 보여줄 요약. */
export interface CompletionSummary {
  count: number;
  /** 가장 이른 예약 날짜(KST). 0건이면 null. */
  from: string | null;
  /** 가장 늦은 예약 날짜(KST). 0건이면 null. */
  to: string | null;
  /** 시작 순으로 정렬된 예약 목록. */
  items: CompletionEntry[];
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
 * 예약 하나를 화면에 나갈 한 줄로 바꾼다.
 *
 * `crossesMidnight` 판정을 `endTime()`에서 파생하는 이유는 `cleaning/diff.ts`와 같다 —
 * '종료가 시작보다 이르면 하루를 더한다'는 규칙이 두 곳으로 갈라지면 한쪽만 고쳐진다.
 */
function entry(r: CompletableReservation): CompletionEntry {
  return {
    id: r.id,
    date: r.date,
    start: r.start_time.slice(0, 5),
    end: r.end_time.slice(0, 5),
    crossesMidnight: endTime(r) > targetTime(r.date, r.end_time),
    name: r.name,
  };
}

/**
 * 건수·날짜 범위·목록으로 줄인다.
 *
 * 날짜는 `date` 문자열을 그대로 쓴다 — 자정을 넘기는 예약도 장부상 하루에 속하고,
 * 담당자에게 "8월 3일부터 8월 9일까지"라고 말하는 편이 실제 종료 시각을 말하는 것보다
 * 눈으로 대조하기 쉽다.
 *
 * 목록은 **날짜·시작 시각 순**이다. 담당자가 아침에 받은 다이제스트 문자도 같은 순서라
 * 두 개를 나란히 놓고 대조할 수 있다.
 */
export function summarize(list: CompletableReservation[]): CompletionSummary {
  if (list.length === 0) return { count: 0, from: null, to: null, items: [] };
  const items = list
    .map(entry)
    .sort((a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date)));
  return {
    count: items.length,
    from: items[0].date,
    to: items[items.length - 1].date,
    items,
  };
}
