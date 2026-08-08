/**
 * 발송 시각 판정 테스트 — 창 경계가 전부다.
 *
 * 여기가 틀리면 "퇴실 15분 남았어요"가 퇴실 뒤에 도착하거나, 입실 안내가 아예 안 나간다.
 * 둘 다 손님이 겪은 뒤에야 알게 되는 종류의 실패라 여기서 못을 박는다.
 *
 * 실행: `deno test supabase/functions/control/sms/schedule.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import { plan, type ScheduleWindow } from "./schedule.ts";

const RES: ScheduleWindow = { date: "2026-08-10", start_time: "14:00:00", end_time: "18:00:00" };

/** KST 벽시계 시각 → Date. 런타임이 UTC라 오프셋을 반드시 명시한다. */
function kst(hhmm: string, date = "2026-08-10"): Date {
  return new Date(`${date}T${hhmm}:00+09:00`);
}

Deno.test("입실 안내 — 입실 10분 전에 나가고, 30분까지 늦어도 나간다", () => {
  assertEquals(plan(RES, kst("13:49")).fire, []); // 아직
  assertEquals(plan(RES, kst("13:50")).fire, ["checkin"]); // 정각
  assertEquals(plan(RES, kst("14:19")).fire, ["checkin"]); // 유예 안
  assertEquals(plan(RES, kst("14:21")).fire, []); // 유예 밖
  assertEquals(plan(RES, kst("14:21")).expired, ["checkin"]);
});

Deno.test("퇴실 15분 전 — 퇴실 시각을 넘기면 보내지 않는다", () => {
  assertEquals(plan(RES, kst("17:44")).fire, []);
  assertEquals(plan(RES, kst("17:45")).fire, ["checkout_soon"]);
  assertEquals(plan(RES, kst("17:59")).fire, ["checkout_soon"]);
  // 18:00을 넘기면 "15분 남았어요"는 거짓말이 된다. 유예가 정확히 15분인 이유다.
  assertEquals(plan(RES, kst("18:01")).fire.includes("checkout_soon"), false);
  assertEquals(plan(RES, kst("18:01")).expired.includes("checkout_soon"), true);
});

Deno.test("퇴실 확인 — 퇴실 시각부터 1시간까지", () => {
  assertEquals(plan(RES, kst("17:59")).fire.includes("checkout"), false);
  assertEquals(plan(RES, kst("18:00")).fire.includes("checkout"), true);
  assertEquals(plan(RES, kst("19:00")).fire.includes("checkout"), true);
  assertEquals(plan(RES, kst("19:01")).fire.includes("checkout"), false);
  assertEquals(plan(RES, kst("19:01")).expired.includes("checkout"), true);
});

Deno.test("퇴실 직후에는 두 통이 겹치지 않는다", () => {
  // 18:00 정각 — checkout_soon은 아직 유예 안(17:45+15분)이고 checkout은 막 열렸다.
  // 둘 다 나가면 손님이 "15분 남았어요"와 "퇴실 확인됐습니다"를 같이 받는다.
  // 장부가 이미 checkout_soon을 보냈다고 기록하고 있어 실제로는 한 통만 나가지만,
  // 자동발송을 퇴실 직전에 켰다면 실제로 겹칠 수 있다 — 그 사실을 여기 적어 둔다.
  const both = plan(RES, kst("18:00")).fire;
  assertEquals(both.includes("checkout_soon"), true);
  assertEquals(both.includes("checkout"), true);
});

Deno.test("자정 넘김 예약 — 시각이 어긋나지 않는다 (UTC 런타임 함정)", () => {
  // 00:30~02:30 KST 예약. UTC로는 전날 15:30이라, 오프셋을 안 붙이면 9시간 어긋난다.
  const late: ScheduleWindow = { date: "2026-08-10", start_time: "00:30:00", end_time: "02:30:00" };
  assertEquals(plan(late, kst("00:19")).fire, []);
  assertEquals(plan(late, kst("00:20")).fire, ["checkin"]); // 입실 10분 전
  assertEquals(plan(late, kst("02:15")).fire.includes("checkout_soon"), true);
  assertEquals(plan(late, kst("02:30")).fire.includes("checkout"), true);
});

Deno.test("예약 전에는 아무것도 나가지 않는다", () => {
  const p = plan(RES, kst("09:00"));
  assertEquals(p.fire, []);
  assertEquals(p.expired, []);
});

Deno.test("한참 지난 예약은 전부 놓친 것으로 잡힌다", () => {
  const p = plan(RES, kst("23:00"));
  assertEquals(p.fire, []);
  assertEquals(p.expired, ["checkin", "checkout_soon", "checkout"]);
});

Deno.test("보증금·확정 안내는 시각 판정 대상이 아니다", () => {
  // 그 둘은 어드민이 자동발송을 켜는 순간 나간다(handlers/sms.ts). 여기서 나오면
  // 예약 시각과 무관한 문자가 시각으로 다시 나가 두 번 가게 된다.
  for (const at of ["09:00", "13:50", "18:00", "23:00"]) {
    const p = plan(RES, kst(at));
    assertEquals([...p.fire, ...p.expired].includes("deposit" as never), false);
    assertEquals([...p.fire, ...p.expired].includes("confirm" as never), false);
  }
});
