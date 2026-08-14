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
  checkinDueState,
  dueState,
  endTime,
  handsOverToNext,
  isOccupied,
  isSweeping,
  kstDay,
  prepDueState,
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

Deno.test("handsOverToNext — 붙어 있는 다음 예약의 준비를 퇴실 종료가 되돌리지 않는다", () => {
  // 스윕은 처음부터 이걸 봤는데 예정된 퇴실 종료만 안 봤다. 그래서 2026-08-14에 앞 예약이
  // 퇴실하는 순간 다음 손님을 위해 켜둔 것이 통째로 꺼졌다.

  // 붙어 있는 경우 — 18:00 퇴실, 다음이 18:00 시작(준비 17:45).
  const back = { date: "2026-08-10", start_time: "18:00:00", end_time: "20:00:00" };
  assertEquals(handsOverToNext([RES, back], RES, kst("2026-08-10T18:00:00")), true);
  // 캐치업 창 안에서 늦게 돌아도 판정은 같아야 한다 — 늦은 인계도 인계다.
  assertEquals(handsOverToNext([RES, back], RES, kst("2026-08-10T18:09:00")), true);

  // 경계 — 다음 예약이 15분 뒤 시작이면 준비 시각이 정확히 퇴실 시각이다. 준비가 이미
  // 같은 분에 돌았으므로 여기서도 끄면 안 된다.
  const exactly15 = { ...back, start_time: "18:15:00" };
  assertEquals(handsOverToNext([RES, exactly15], RES, kst("2026-08-10T18:00:00")), true);

  // 16분 뒤 시작이면 준비(18:01)가 아직 안 돌았다 — 퇴실 종료가 정상적으로 돌아야 한다.
  const after16 = { ...back, start_time: "18:16:00" };
  assertEquals(handsOverToNext([RES, after16], RES, kst("2026-08-10T18:00:00")), false);

  // 다음 예약이 없으면 당연히 끈다.
  assertEquals(handsOverToNext([RES], RES, kst("2026-08-10T18:00:00")), false);
});

Deno.test("handsOverToNext — 자기 자신은 인계 상대가 아니다", () => {
  // 퇴실 시각엔 `now < endTime(r)`가 이미 거짓이라 결과는 같지만, 시각이 같은 예약이
  // 둘 있을 때(중복 동기화) 자기 자신을 인계 상대로 세면 아무 예약도 종료되지 않는다.
  const twin: ReservationWindow = { ...RES };
  assertEquals(handsOverToNext([RES], RES, kst("2026-08-10T16:00:00")), false);
  assertEquals(handsOverToNext([RES, twin], RES, kst("2026-08-10T16:00:00")), true);
});

Deno.test("prepDueState — 앞 손님이 아직 있으면 준비를 그 퇴실 시각까지 미룬다", () => {
  // RES는 14:00~18:00. 다음이 18:00~20:00이면 준비 시각은 17:45 — 앞 손님의 마지막 15분이다.
  // 그대로 쏘면 앞 손님의 에어컨이 26도·냉방으로 바뀌고 SiHAS 조명이 꺼진다.
  const next: ReservationWindow = { date: "2026-08-10", start_time: "18:00:00", end_time: "20:00:00" };
  const both = [RES, next];

  assertEquals(prepDueState(both, next, kst("2026-08-10T17:45:00")), "wait");
  assertEquals(prepDueState(both, next, kst("2026-08-10T17:59:00")), "wait");
  // 앞 예약이 끝나는 그 분에 준비가 돈다 = 인계. 같은 분에 도는 퇴실 종료는
  // `handsOverToNext`가 건너뛴다 — 두 판정 중 하나만 있으면 이 시나리오가 안 막힌다.
  assertEquals(prepDueState(both, next, kst("2026-08-10T18:00:00")), "fire");

  // 앞 예약이 없으면 평소대로 15분 전에 돈다.
  assertEquals(prepDueState([next], next, kst("2026-08-10T17:45:00")), "fire");
});

Deno.test("prepDueState — 겹쳐 잡힌 예약은 조용히 수습하지 않고 만료시킨다", () => {
  // 앞 예약이 다음 예약의 입실 시각 + 캐치업 창(10분)을 넘겨서까지 이어지는 경우.
  // 뒤늦게 준비를 쏘면 이미 이용 중인 손님이 맞춰둔 값과 싸우므로, 만료로 두고 채널에 띄운다.
  const long: ReservationWindow = { date: "2026-08-10", start_time: "14:00:00", end_time: "18:30:00" };
  const next: ReservationWindow = { date: "2026-08-10", start_time: "18:00:00", end_time: "20:00:00" };
  const both = [long, next];

  assertEquals(prepDueState(both, next, kst("2026-08-10T18:05:00")), "wait");
  assertEquals(prepDueState(both, next, kst("2026-08-10T18:30:00")), "expired");
});

Deno.test("prepDueState — 시작이 같은 중복 예약은 서로를 앞 손님으로 보지 않는다", () => {
  // 같은 예약이 두 행으로 동기화됐을 때 시작 시각을 `<=`로 비교하면 서로를 기다리며
  // 양쪽 다 영원히 준비를 미룬다 — 그날 준비가 통째로 안 돈다.
  const twin: ReservationWindow = { ...RES };
  assertEquals(prepDueState([RES, twin], RES, kst("2026-08-10T13:45:00")), "fire");
});

Deno.test("handsOverToNext — 자정을 넘겨 이어지는 예약도 인계로 본다", () => {
  // 22:00~02:00 예약의 종료는 다음 날 02:00이다(endTime). 그 뒤에 02:00 시작 예약이 붙으면
  // 준비는 01:45 — 날짜 문자열만 보면 '어제와 오늘'이라 놓치기 쉽다.
  const night: ReservationWindow = {
    date: "2026-08-10",
    start_time: "22:00:00",
    end_time: "02:00:00",
  };
  const morning: ReservationWindow = {
    date: "2026-08-11",
    start_time: "02:00:00",
    end_time: "04:00:00",
  };
  assertEquals(handsOverToNext([night, morning], night, kst("2026-08-11T02:00:00")), true);
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

// ── 입실 준비의 만료 경계 (checkinDueState) ─────────────────────────────────
//
// 일반 dueState는 '실행 시각 + 10분'을 넘기면 만료다. 입실 준비는 그 규칙을 그대로 쓰면
// 안 된다 — 실행 시각(입실 15분 전)과 **의미 있는 마감**(입실 시각)이 다르기 때문이다.
// 스클 당일 즉시 예약이 Gmail 15분 트리거로 늦게 들어오면, 준비 시각은 이미 지났지만
// 손님은 아직 안 왔다. 그때 준비를 건너뛰면 손님이 안 준비된 방에 들어오고, 채널에는
// 장애처럼 읽히는 실패만 남는다.

const CHECKIN: ReservationWindow = { date: "2026-08-12", start_time: "14:00:00", end_time: "18:00:00" };

Deno.test("입실 준비 — 준비 시각(14:00-15분) 전이면 아직이다", () => {
  assertEquals(checkinDueState(CHECKIN, kst("2026-08-12T13:44")), "wait");
});

Deno.test("입실 준비 — 준비 시각이 되면 실행한다", () => {
  assertEquals(checkinDueState(CHECKIN, kst("2026-08-12T13:45")), "fire");
});

Deno.test("입실 준비 — 준비 시각을 10분 넘겨도 입실 전이면 여전히 실행한다", () => {
  // 여기가 이 함수의 존재 이유다. 일반 dueState라면 13:56에 이미 expired가 된다.
  assertEquals(dueState(prepTime(CHECKIN), kst("2026-08-12T13:56")), "expired");
  assertEquals(checkinDueState(CHECKIN, kst("2026-08-12T13:56")), "fire");
  assertEquals(checkinDueState(CHECKIN, kst("2026-08-12T13:59")), "fire");
});

Deno.test("입실 준비 — 입실 시각 직후 10분까지는 따라잡는다", () => {
  assertEquals(checkinDueState(CHECKIN, kst("2026-08-12T14:00")), "fire");
  assertEquals(checkinDueState(CHECKIN, kst("2026-08-12T14:10")), "fire");
});

Deno.test("입실 준비 — 입실 후 10분을 넘기면 만료다", () => {
  // 손님이 이미 한참 이용 중이면 뒤늦은 준비가 손님이 맞춰둔 값과 싸운다.
  assertEquals(checkinDueState(CHECKIN, kst("2026-08-12T14:11")), "expired");
});

Deno.test("입실 준비 — 자정 넘김 예약에서도 경계가 유지된다", () => {
  const overnight: ReservationWindow = { date: "2026-08-12", start_time: "00:05:00", end_time: "02:00:00" };
  assertEquals(checkinDueState(overnight, kst("2026-08-11T23:49")), "wait");
  assertEquals(checkinDueState(overnight, kst("2026-08-11T23:50")), "fire");
  assertEquals(checkinDueState(overnight, kst("2026-08-12T00:15")), "fire");
  assertEquals(checkinDueState(overnight, kst("2026-08-12T00:16")), "expired");
});
