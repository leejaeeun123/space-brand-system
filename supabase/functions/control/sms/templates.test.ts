/**
 * 문구 테스트 — 손님에게 나가는 글자를 발송 없이 고정한다.
 *
 * 특히 **요일**을 본다. 런타임이 UTC라 KST 00:00~09:00 예약은 요일이 하루 밀리기 쉬운데
 * (`windows.ts`가 경고하는 바로 그 함정), 개발 맥은 KST라 우연히 맞게 나와 눈으로는 안 잡힌다.
 *
 * 실행: `deno test supabase/functions/control/sms/templates.test.ts`
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { kindsFor, KIND_LABEL, render, type ReservationForSms, SMS_KINDS } from "./templates.ts";

function reservation(over: Partial<ReservationForSms> = {}): ReservationForSms {
  return {
    date: "2026-08-10", // 월요일
    start_time: "14:00:00",
    end_time: "18:00:00",
    deposit_required: false,
    ...over,
  };
}

Deno.test("예약 일시 — 날짜·요일·시작–종료가 한 줄에 들어간다", () => {
  assertStringIncludes(
    render("confirm", reservation()),
    "예약 일시: 2026.08.10(월) 14:00–18:00",
  );
});

Deno.test("요일 — 자정 직후 예약도 그날 요일로 나온다 (UTC 런타임 함정)", () => {
  // 00:30 KST = 전날 15:30 UTC. timeZone을 안 넘기면 여기서 '일'이 나온다.
  assertStringIncludes(
    render("confirm", reservation({ start_time: "00:30:00", end_time: "04:30:00" })),
    "2026.08.10(월) 00:30–04:30",
  );
});

Deno.test("요일 — 같은 날짜면 시각이 달라도 요일이 같다", () => {
  const dawn = render("confirm", reservation({ start_time: "00:30:00", end_time: "02:00:00" }));
  const noon = render("confirm", reservation({ start_time: "12:00:00", end_time: "14:00:00" }));
  const weekdayOf = (text: string) => text.match(/\((.)\)/)?.[1];
  assertEquals(weekdayOf(dawn), weekdayOf(noon));
});

Deno.test("보증금 유무로 confirm·checkout 문구가 갈린다", () => {
  const withDeposit = reservation({ deposit_required: true });
  const without = reservation({ deposit_required: false });

  assertStringIncludes(render("confirm", withDeposit), "보증금 입금 확인되어 예약 확정");
  assertEquals(render("confirm", without).includes("보증금"), false);

  assertStringIncludes(render("checkout", withDeposit), "24시간 내로 입금하신 계좌로 환불");
  assertEquals(render("checkout", without).includes("환불"), false);
});

Deno.test("kindsFor — 보증금을 안 받으면 deposit이 아예 없다", () => {
  assertEquals(kindsFor(reservation({ deposit_required: true })), [
    "deposit",
    "confirm",
    "checkin",
    "checkout_soon",
    "checkout",
  ]);
  assertEquals(kindsFor(reservation({ deposit_required: false })), [
    "confirm",
    "checkin",
    "checkout_soon",
    "checkout",
  ]);
});

Deno.test("모든 문구 — 치환 안 된 자리표시자가 남지 않는다", () => {
  for (const kind of SMS_KINDS) {
    for (const deposit of [true, false]) {
      const text = render(kind, reservation({ deposit_required: deposit }));
      assertEquals(/\[날짜|\[시간|\{\{|undefined|NaN|Invalid Date/.test(text), false, `${kind}/${deposit}: ${text}`);
      assertStringIncludes(text, "[타입라운지]");
    }
  }
});

Deno.test("모든 문구 — LMS 상한(2000바이트) 안에 들어간다", () => {
  // SOLAPI LMS는 2000바이트다. 넘으면 벤더가 거절하는데, 그 실패는 발송 시점에야 보인다.
  for (const kind of SMS_KINDS) {
    const text = render(kind, reservation({ deposit_required: true }));
    const bytes = new TextEncoder().encode(text).length;
    assertEquals(bytes < 2000, true, `${KIND_LABEL[kind]}: ${bytes}바이트`);
  }
});

Deno.test("퇴실 15분 전 — 다음 예약 문장은 항상 들어간다 (형운 결정 2026-08-08)", () => {
  // 다음 예약이 없는 날에는 사실이 아니지만 유지하기로 한 문장이다.
  // 조건부로 바꾸는 변경이 들어오면 이 테스트가 먼저 깨져 결정을 다시 보게 한다.
  assertStringIncludes(render("checkout_soon", reservation()), "바로 다음 시간에 예약하신 분이 계셔서");
});
