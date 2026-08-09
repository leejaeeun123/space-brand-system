/**
 * 청소 완료 대상 선별 테스트.
 *
 * 라이브 DB에 테스트 예약을 만들 수 없어(같은 행이 기기 자동화의 입력이라 손님 머리 위로
 * 냉난방이 돈다 — 2026-08-08 사고) 이 판정은 **여기서만** 검증된다. 특히 자정을 넘기는
 * 예약은 실제로 겪기 전엔 안 보이는 함정이고(#41), 여기서 안 잡으면 손님이 안에 있는데
 * 청소가 끝났다고 장부에 적힌다.
 *
 * 실행: `deno test supabase/functions/control/cleaning/completion.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import { type CompletableReservation, endedBy, summarize } from "./completion.ts";

const DAY = "2026-08-09";

function res(id: string, start: string, end: string, date = DAY, name = "홍길동"): CompletableReservation {
  return { id, date, start_time: start, end_time: end, name };
}

/** KST 벽시계 → Date. 런타임 타임존과 무관하게 같은 순간을 가리킨다. */
function kst(hhmm: string, date = DAY): Date {
  return new Date(`${date}T${hhmm}:00+09:00`);
}

function ids(list: CompletableReservation[]): string[] {
  return list.map((r) => r.id);
}

Deno.test("끝난 예약만 고른다 — 진행 중과 미래는 빠진다", () => {
  const list = [
    res("past", "10:00:00", "12:00:00"),
    res("now", "13:00:00", "16:00:00"),
    res("future", "18:00:00", "20:00:00"),
  ];
  assertEquals(ids(endedBy(list, kst("14:00"))), ["past"]);
});

Deno.test("경계는 포함이다 — 종료 시각 정각에 찍어도 그 예약은 끝난 것이다", () => {
  const list = [res("a", "10:00:00", "12:00:00")];
  assertEquals(ids(endedBy(list, kst("12:00"))), ["a"]);
  assertEquals(ids(endedBy(list, kst("11:59"))), []);
});

Deno.test("자정을 넘기는 예약은 다음 날 종료 시각까지 끝난 게 아니다", () => {
  // 8/9 22:00 시작 → 8/10 02:00 종료. 8/10 00:30에 찍으면 손님이 아직 안에 있다.
  const list = [res("overnight", "22:00:00", "02:00:00")];
  assertEquals(ids(endedBy(list, kst("00:30", "2026-08-10"))), []);
  assertEquals(ids(endedBy(list, kst("02:00", "2026-08-10"))), ["overnight"]);
});

Deno.test("자정 정각에 끝나는 예약도 다음 날이 종료다", () => {
  // 18:00~00:00. 문자열로 비교하면 이 예약이 당일 00:00에 이미 끝난 것으로 보인다(#41).
  const list = [res("midnight", "18:00:00", "00:00:00")];
  assertEquals(ids(endedBy(list, kst("23:59"))), []);
  assertEquals(ids(endedBy(list, kst("00:00", "2026-08-10"))), ["midnight"]);
});

Deno.test("며칠 전 예약도 대상이다 — 소급 범위를 여기서 자르지 않는다", () => {
  const list = [
    res("old", "10:00:00", "12:00:00", "2026-07-01"),
    res("recent", "10:00:00", "12:00:00", "2026-08-08"),
  ];
  assertEquals(ids(endedBy(list, kst("09:00"))), ["old", "recent"]);
});

Deno.test("빈 목록은 빈 목록이다", () => {
  assertEquals(endedBy([], kst("12:00")), []);
});

Deno.test("요약 — 건수와 날짜 범위", () => {
  const list = [
    res("b", "10:00:00", "12:00:00", "2026-08-08"),
    res("a", "10:00:00", "12:00:00", "2026-07-30"),
    res("c", "10:00:00", "12:00:00", "2026-08-09"),
  ];
  const s = summarize(list);
  assertEquals(s.count, 3);
  assertEquals(s.from, "2026-07-30");
  assertEquals(s.to, "2026-08-09");
});

Deno.test("0건 요약은 날짜가 없다 — 없는 범위를 지어내지 않는다", () => {
  assertEquals(summarize([]), { count: 0, from: null, to: null, items: [] });
});

Deno.test("1건이면 시작과 끝이 같다", () => {
  const s = summarize([res("a", "10:00:00", "12:00:00")]);
  assertEquals(s.count, 1);
  assertEquals(s.from, DAY);
  assertEquals(s.to, DAY);
});

Deno.test("목록은 날짜·시작 시각 순이다 — 아침 문자와 나란히 놓고 대조한다", () => {
  const list = [
    res("late", "18:00:00", "20:00:00", DAY, "박수현"),
    res("yesterday", "13:00:00", "15:00:00", "2026-08-08", "이서준"),
    res("early", "09:00:00", "11:00:00", DAY, "김민지"),
  ];
  assertEquals(summarize(list).items.map((e) => e.id), ["yesterday", "early", "late"]);
});

Deno.test("한 줄에 담기는 것 — 날짜·시각·이름, 그리고 그것뿐", () => {
  const s = summarize([res("a", "14:00:00", "17:00:00", DAY, "김민지")]);
  assertEquals(s.items[0], {
    id: "a",
    date: DAY,
    start: "14:00",
    end: "17:00",
    crossesMidnight: false,
    name: "김민지",
  });
});

Deno.test("자정을 넘기면 표시로 남는다 — 22:00–02:00을 거꾸로 읽지 않게", () => {
  const overnight = summarize([res("a", "22:00:00", "02:00:00")]).items[0];
  assertEquals(overnight.crossesMidnight, true);
  assertEquals(overnight.end, "02:00");
  // 자정 정각 종료도 다음 날이다 — #41과 같은 자리.
  assertEquals(summarize([res("b", "18:00:00", "00:00:00")]).items[0].crossesMidnight, true);
});
