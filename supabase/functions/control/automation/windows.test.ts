/**
 * `windows.ts` 테스트 — 자동화에서 유일하게 순수한 층이자, 틀리면 가장 조용한 층이다.
 *
 * **모든 단언을 `toISOString()`(UTC 절대시각)으로 한다.** `getHours()` 같은 로컬 게터로
 * 검증하면 개발 맥(KST)에서는 통과하고 배포 런타임(UTC)에서는 9시간 어긋난 채로 통과한다 —
 * 실제로 이 테스트의 첫 판이 그 함정에 빠져 KST 파싱 버그를 못 잡았다.
 *
 * 실행: `deno test supabase/functions/control/automation/windows.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  dueState,
  endTime,
  isOccupied,
  isSweeping,
  kstDay,
  prepTime,
  sweepElapsedMinutes,
  targetTime,
  type ReservationWindow,
} from "./windows.ts";

/** 테스트용 KST 시각. 런타임 타임존과 무관하게 같은 순간을 가리킨다. */
function kst(iso: string): Date {
  return new Date(`${iso}+09:00`);
}

/** 14:00~18:00 KST 예약 하나. */
const RES: ReservationWindow = {
  date: "2026-08-10",
  start_time: "14:00:00",
  end_time: "18:00:00",
};

Deno.test("targetTime — 예약 시각을 KST로 해석한다 (런타임 타임존 무관)", () => {
  // 14:30 KST = 05:30 UTC. 오프셋 없이 파싱했다면 UTC 런타임에서 14:30Z가 나온다.
  assertEquals(
    targetTime("2026-08-10", "14:30:00").toISOString(),
    "2026-08-10T05:30:00.000Z",
  );
});

Deno.test("kstDay — UTC 날짜가 아니라 KST 달력 날짜다", () => {
  // 2026-08-10 00:30 KST는 UTC로는 아직 08-09다. UTC 기준으로 자르면 어제로 조회된다.
  assertEquals(kstDay(kst("2026-08-10T00:30:00")), "2026-08-10");
  assertEquals(kstDay(kst("2026-08-10T23:30:00")), "2026-08-10");
});

Deno.test("prepTime — 입실 15분 전", () => {
  assertEquals(prepTime(RES).toISOString(), kst("2026-08-10T13:45:00").toISOString());
});

Deno.test("endTime — 퇴실 시각 그대로", () => {
  assertEquals(endTime(RES).toISOString(), kst("2026-08-10T18:00:00").toISOString());
});

Deno.test("dueState — 전이면 wait, 그 순간과 캐치업 창 안이면 fire, 넘기면 expired", () => {
  const target = kst("2026-08-10T13:45:00");
  assertEquals(dueState(target, kst("2026-08-10T13:44:00")), "wait");
  assertEquals(dueState(target, target), "fire");
  assertEquals(dueState(target, kst("2026-08-10T13:54:59")), "fire");
  assertEquals(dueState(target, kst("2026-08-10T13:56:00")), "expired");
});

Deno.test("isOccupied — 준비 시작부터 퇴실 직전까지", () => {
  assertEquals(isOccupied([RES], kst("2026-08-10T13:44:00")), false); // 준비 전
  assertEquals(isOccupied([RES], kst("2026-08-10T13:45:00")), true); // 준비 시작
  assertEquals(isOccupied([RES], kst("2026-08-10T16:00:00")), true); // 이용 중
  assertEquals(isOccupied([RES], kst("2026-08-10T17:59:59")), true);
  assertEquals(isOccupied([RES], kst("2026-08-10T18:00:00")), false); // 퇴실 시각은 제외
});

Deno.test("isSweeping — 퇴실 후 10분 동안만", () => {
  assertEquals(isSweeping([RES], kst("2026-08-10T17:59:00")), false); // 아직 이용 중
  assertEquals(isSweeping([RES], kst("2026-08-10T18:00:00")), true);
  assertEquals(isSweeping([RES], kst("2026-08-10T18:09:59")), true);
  assertEquals(isSweeping([RES], kst("2026-08-10T18:10:00")), false); // 창이 닫혔다
});

Deno.test("isSweeping — 다음 예약이 바로 붙어 있으면 스윕하지 않는다", () => {
  // 18:15 시작 예약의 준비 시각은 18:00 — 앞 예약의 스윕 창과 정확히 겹친다.
  // 여기서 스윕이 돌면 다음 손님을 위해 켠 조명·냉난방을 도로 끈다.
  const next: ReservationWindow = {
    date: "2026-08-10",
    start_time: "18:15:00",
    end_time: "20:00:00",
  };
  assertEquals(isSweeping([RES, next], kst("2026-08-10T18:00:00")), false);
  assertEquals(isSweeping([RES, next], kst("2026-08-10T18:05:00")), false);
  // 다음 예약이 충분히 뒤면(준비 19:45) 스윕 창은 정상적으로 열린다.
  const later: ReservationWindow = { ...next, start_time: "20:00:00", end_time: "22:00:00" };
  assertEquals(isSweeping([RES, later], kst("2026-08-10T18:05:00")), true);
});

Deno.test("예약이 없으면 어느 창도 열리지 않는다", () => {
  assertEquals(isOccupied([], kst("2026-08-10T18:05:00")), false);
  assertEquals(isSweeping([], kst("2026-08-10T18:05:00")), false);
});

Deno.test("sweepElapsedMinutes — 스윕 중이 아니면 null, 맞으면 경과 분", () => {
  assertEquals(sweepElapsedMinutes([RES], kst("2026-08-10T17:59:00")), null); // 이용 중
  assertEquals(sweepElapsedMinutes([RES], kst("2026-08-10T18:00:00")), 0);
  assertEquals(sweepElapsedMinutes([RES], kst("2026-08-10T18:09:00")), 9);
  assertEquals(sweepElapsedMinutes([RES], kst("2026-08-10T18:10:00")), null); // 창이 닫혔다
});

Deno.test("sweepElapsedMinutes — 마지막 틱(9분)이 잔존 기기 알림의 기준이다", () => {
  // 이 값이 9 이상이어야 "10분간 껐는데 안 꺼졌다"를 한 번 알린다. 창이 닫힌 뒤엔 아무도
  // 안 보므로, 여기서 못 잡으면 조명이 밤새 켜져 있어도 채널엔 아무것도 안 남는다.
  const last = sweepElapsedMinutes([RES], kst("2026-08-10T18:09:30"));
  assertEquals(last !== null && last >= 9, true);
});

Deno.test("sweepElapsedMinutes — 겹친 예약은 가장 이른 퇴실을 창의 시작으로 본다", () => {
  // 늦은 쪽을 잡으면 호출부의 '이번 창에서 이미 스윕했나' 조회 범위가 실제 스윕 시작보다
  // 짧아져 같은 기기를 다시 알린다.
  const reservations: ReservationWindow[] = [
    { date: "2026-08-10", start_time: "00:00:00", end_time: "01:00:00" },
    { date: "2026-08-10", start_time: "00:30:00", end_time: "01:02:00" },
  ];
  assertEquals(sweepElapsedMinutes(reservations, new Date("2026-08-10T01:06:00+09:00")), 6);
});

Deno.test("자정 직후 예약의 준비 시각은 전날이다 — 조회 범위가 하루 더 필요한 이유", () => {
  const r: ReservationWindow = { date: "2026-08-10", start_time: "00:05:00", end_time: "02:00:00" };
  assertEquals(prepTime(r).toISOString(), new Date("2026-08-09T23:50:00+09:00").toISOString());

  // 자정을 넘겨 처음 보이는 틱에서는 이미 캐치업 창(10분) 밖이다 — 조회에서 빠지면
  // 입실 준비가 통째로 누락된다.
  const firstTick = new Date("2026-08-10T00:00:30+09:00");
  assertEquals(dueState(prepTime(r), firstTick), "expired");

  // 00:06 시작이면 같은 틱에서 아슬하게 살아난다(단 리드타임은 15분이 아니라 9분 남음).
  // 그래서 통째 누락은 00:00~00:05 구간이고, 그 밖은 '늦게 돌았다'가 된다.
  assertEquals(dueState(prepTime({ ...r, start_time: "00:06:00" }), firstTick), "fire");
});

Deno.test("자정 종료 예약 — 퇴실 시각이 시작보다 이르면 안 된다", () => {
  // 이걸 놓치면 퇴실 종료가 시작 18시간 전에 돌아 checkout_automation_at이 찍히고,
  // 진짜 퇴실에는 '이미 했다'고 보고 아무것도 안 꺼진다 — 냉난방이 밤새 돈다.
  const late = { date: "2026-08-23", start_time: "18:00:00", end_time: "00:00:00" };
  assertEquals(endTime(late).toISOString(), kst("2026-08-24T00:00:00").toISOString());
  assertEquals(endTime(late) > prepTime(late), true);

  const overnight = { date: "2026-08-23", start_time: "22:00:00", end_time: "02:00:00" };
  assertEquals(endTime(overnight).toISOString(), kst("2026-08-24T02:00:00").toISOString());

  // 이용 중 판정도 따라와야 한다 — 안 그러면 손님 머리 위로 스윕이 돈다
  assertEquals(isOccupied([late], kst("2026-08-23T23:00:00")), true);
  assertEquals(isOccupied([overnight], kst("2026-08-24T01:00:00")), true);
  assertEquals(isOccupied([late], kst("2026-08-24T01:00:00")), false);
});
