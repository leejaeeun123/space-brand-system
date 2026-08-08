/**
 * 청소 창 계산 테스트 — 이 기능이 실제로 말하는 한 줄이 전부 여기서 나온다.
 *
 * 라이브 DB에 테스트 예약을 만들 수 없어서(같은 행이 기기 자동화의 입력이라 손님 머리 위로
 * 냉난방이 돈다 — 2026-08-08 사고) 창 계산은 **여기서만** 검증된다. 느슨하게 두면
 * 담당자가 없는 시간에 가거나, 손님이 있는 시간에 문을 연다.
 *
 * 실행: `deno test supabase/functions/control/cleaning/windows.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  type CleaningReservation,
  isCarryOver,
  isNextDay,
  planCleaning,
  remaining,
  todayReservations,
} from "./windows.ts";

const DAY = "2026-08-09";
const YESTERDAY = "2026-08-08";

function res(
  start: string,
  end: string,
  over: Partial<CleaningReservation> = {},
): CleaningReservation {
  return {
    id: `${over.date ?? DAY} ${start}`,
    date: DAY,
    start_time: `${start}:00`,
    end_time: `${end}:00`,
    name: "손님",
    guests: null,
    purpose: null,
    ...over,
  };
}

/** KST 벽시계 → Date. 런타임이 UTC라 오프셋을 반드시 명시한다. */
function kst(hhmm: string, date = DAY): Date {
  return new Date(`${date}T${hhmm}:00+09:00`);
}

/** Date → KST 'HH:MM'. null은 '경계 없음'이라 그대로 통과시킨다. */
function at(d: Date | null): string | null {
  return d === null ? null : new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16);
}

function shape(plan: ReturnType<typeof planCleaning>) {
  return {
    windows: plan.windows.map((w) => [at(w.from), at(w.to), w.minutes]),
    tight: plan.tight.map((g) => [at(g.afterEnd), at(g.beforeStart), g.minutes]),
  };
}

Deno.test("예약 사이 공백이 청소 창이 된다", () => {
  const plan = planCleaning([res("09:00", "12:00"), res("13:00", "17:00")], kst("07:00"));
  assertEquals(shape(plan), {
    windows: [
      ["00:00", "09:00", 540], // 하루 시작 ~ 첫 예약
      ["12:00", "13:00", 60], // 사이
      ["17:00", null, null], // 마지막 퇴실 이후 — 끝 경계가 없다
    ],
    tight: [],
  });
});

Deno.test("30분 경계 — 30분은 창, 29분은 경고", () => {
  const gap = (end: string, nextStart: string) =>
    shape(planCleaning([res("09:00", end), res(nextStart, "20:00")], kst("07:00")));

  // 정확히 30분이면 청소할 수 있다고 본다
  assertEquals(gap("12:00", "12:30").windows[1], ["12:00", "12:30", 30]);
  assertEquals(gap("12:00", "12:30").tight, []);

  // 29분이면 창이 아니라 경고다
  assertEquals(gap("12:00", "12:29").windows.length, 2); // 첫 구간 + 마지막 구간만
  assertEquals(gap("12:00", "12:29").tight, [["12:00", "12:29", 29]]);

  // 31분은 다시 창
  assertEquals(gap("12:00", "12:31").windows[1], ["12:00", "12:31", 31]);
});

Deno.test("예약이 0건이면 하루 전체가 창이다", () => {
  const plan = planCleaning([], kst("07:00"));
  assertEquals(shape(plan), { windows: [[null, null, null]], tight: [] });
  // 자르고 나서도 그대로다 — 경계가 없으니 자를 것이 없다.
  assertEquals(shape(remaining(plan, kst("15:00"))), { windows: [[null, null, null]], tight: [] });
});

Deno.test("붙어 있는 예약은 0분 경고 — 음수로 새지 않는다", () => {
  const back = planCleaning([res("09:00", "12:00"), res("12:00", "15:00")], kst("07:00"));
  assertEquals(back.tight, [{ afterEnd: kst("12:00"), beforeStart: kst("12:00"), minutes: 0 }]);

  // 겹친 예약(단일 공간이라 실제로는 불가능하지만 방어한다) — 음수 분이 나오면 안 된다
  const overlap = planCleaning([res("09:00", "13:00"), res("12:00", "15:00")], kst("07:00"));
  assertEquals(overlap.tight.map((g) => g.minutes), [0]);
  // 커서가 뒤로 가지 않아 마지막 창은 늦은 퇴실 기준이다
  assertEquals(at(overlap.windows.at(-1)!.from), "15:00");
});

Deno.test("하루 첫 예약이 이르다고 연달림 경고를 내지 않는다", () => {
  // 00:20 시작 — 앞에 예약이 없으니 '연달림'이 아니다. 경고하면 매일 아침 거짓 경고가 뜬다.
  const plan = planCleaning([res("00:20", "04:00")], kst("07:00"));
  assertEquals(plan.tight, []);
  assertEquals(at(plan.windows[0].from), "04:00"); // 첫 창은 그 예약 뒤부터
});

Deno.test("자정을 넘겨 끝나는 예약 — 마지막 창이 다음 날로 간다", () => {
  const plan = planCleaning([res("22:00", "02:00")], kst("12:00"));
  const last = plan.windows.at(-1)!;
  assertEquals(last.from!.toISOString(), new Date("2026-08-10T02:00:00+09:00").toISOString());
  assertEquals(isNextDay(last.from!, kst("12:00")), true);
});

Deno.test("어제에서 넘어온 예약이 첫 창의 시작을 민다", () => {
  const overnight = res("22:00", "02:00", { date: YESTERDAY, id: "어제밤" });
  const today = res("10:00", "12:00");

  // 조회 결과에는 어제·내일이 섞여 있다 — 오늘 몫만 골라야 한다
  const tomorrow = res("09:00", "11:00", { date: "2026-08-10", id: "내일" });
  const picked = todayReservations([overnight, today, tomorrow], kst("07:00"));
  assertEquals(picked.map((r) => r.id), ["어제밤", `${DAY} 10:00`]);
  assertEquals(isCarryOver(overnight, kst("07:00")), true);
  assertEquals(isCarryOver(today, kst("07:00")), false);

  // 넘어온 예약 자체는 구간을 만들지 않고, 그 종료가 첫 경계가 된다
  const plan = planCleaning(picked, kst("07:00"));
  assertEquals(shape(plan), {
    windows: [["02:00", "10:00", 480], ["12:00", null, null]],
    tight: [],
  });
});

Deno.test("어제 예약이라도 오늘까지 안 이어지면 빠진다", () => {
  const done = res("13:00", "17:00", { date: YESTERDAY, id: "어제낮" });
  assertEquals(todayReservations([done], kst("07:00")), []);
});

Deno.test("이미 지난 창은 문자에 싣지 않는다", () => {
  const plan = planCleaning([res("09:00", "12:00"), res("13:00", "17:00")], kst("07:00"));

  // 07:00 — 첫 창은 자정부터였지만 지금부터로 당겨진다
  assertEquals(shape(remaining(plan, kst("07:00"))).windows, [
    ["07:00", "09:00", 120],
    ["12:00", "13:00", 60],
    ["17:00", null, null],
  ]);

  // 14:00 — 오전 창 둘은 이미 끝났다
  assertEquals(shape(remaining(plan, kst("14:00"))).windows, [["17:00", null, null]]);

  // 12:20 — 진행 중인 창은 남은 부분만 (40분 남아 아직 창이다)
  assertEquals(shape(remaining(plan, kst("12:20"))).windows[0], ["12:20", "13:00", 40]);
});

Deno.test("남은 시간이 30분 미만인 창은 경고로 바꾸지 않고 뺀다", () => {
  const plan = planCleaning([res("09:00", "12:00"), res("13:00", "17:00")], kst("07:00"));
  const late = remaining(plan, kst("12:40")); // 12:00–13:00 창에 20분 남음
  // 실행할 수 없는 안내를 적으면 문자 전체의 신뢰가 깎인다 — 조용히 뺀다
  assertEquals(shape(late).windows, [["17:00", null, null]]);
  // 연달림 경고로 둔갑시키지 않는다. 연달림은 스케줄의 성질이지 지금 몇 시인가의 문제가 아니다
  assertEquals(late.tight, []);
});

Deno.test("지나간 연달림 경고는 사라진다", () => {
  const plan = planCleaning([res("09:00", "12:00"), res("12:20", "17:00")], kst("07:00"));
  assertEquals(shape(plan).tight, [["12:00", "12:20", 20]]);
  assertEquals(remaining(plan, kst("13:00")).tight, []); // 이미 지난 일이다
  assertEquals(shape(remaining(plan, kst("11:00"))).tight, [["12:00", "12:20", 20]]);
});

Deno.test("마지막 창은 시작 시각을 지금으로 당기지 않는다", () => {
  // "20:00 이후"는 21시에 읽어도 참이다. 매 틱 문구가 흔들리면 같은 내용이 다른 문자로 보인다.
  const plan = planCleaning([res("17:00", "20:00")], kst("07:00"));
  assertEquals(shape(remaining(plan, kst("21:00"))).windows, [["20:00", null, null]]);
});
