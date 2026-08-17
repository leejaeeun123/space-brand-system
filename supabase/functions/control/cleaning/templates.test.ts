/**
 * 문구 테스트 — 담당자가 실제로 읽는 글자를 고정한다.
 *
 * 특히 **연락처가 본문에 없는 것**과 **빈 값이 빈칸으로 새지 않는 것**을 못 박는다.
 * `purpose`는 Gmail 경로 예약에서 항상 비어 있어, 이 검증이 없으면 매일 아침
 * "09:00–12:00 김민수 6명 · " 같은 줄이 나간다.
 *
 * 실행: `deno test supabase/functions/control/cleaning/templates.test.ts`
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildSnapshot } from "./diff.ts";
import { compare } from "./diff.ts";
import { accessBlock, digestMessage, updateMessage } from "./templates.ts";
import { type CleaningReservation, planCleaning, remaining } from "./windows.ts";

const DAY = "2026-08-09"; // 일요일

function res(
  id: string,
  start: string,
  end: string,
  over: Partial<CleaningReservation> = {},
): CleaningReservation {
  return {
    id,
    date: DAY,
    start_time: `${start}:00`,
    end_time: `${end}:00`,
    name: "김민수",
    guests: 6,
    purpose: null,
    ...over,
  };
}

function kst(hhmm: string, date = DAY): Date {
  return new Date(`${date}T${hhmm}:00+09:00`);
}

function digest(list: CleaningReservation[], now: Date): string {
  return digestMessage(
    buildSnapshot(list, now).entries,
    remaining(planCleaning(list, now), now),
    now,
  );
}

Deno.test("다이제스트 — 예약 목록과 청소 창이 한 통에 담긴다", () => {
  const body = digest([
    res("a", "09:00", "12:00", { purpose: "회의" }),
    res("b", "13:00", "17:00", { name: "윤단비", guests: 8, purpose: "파티룸" }),
    res("c", "17:20", "20:00", { name: "이지훈", guests: 4 }),
  ], kst("07:00"));

  assertEquals(body.split("\n"), [
    "[타입라운지] 8/9(일) 청소 안내",
    "",
    "■ 오늘 예약 3건",
    "09:00–12:00 김민수 6명 · 회의",
    "13:00–17:00 윤단비 8명 · 파티룸",
    "17:20–20:00 이지훈 4명",
    "",
    "■ 청소 가능",
    "07:00–09:00 (2시간)",
    "12:00–13:00 (1시간)",
    "20:00 이후",
    "",
    "⚠️ 17:00→17:20 사이는 20분이라 청소 시간이 없어요",
  ]);
});

Deno.test("예약이 0건이어도 보낸다", () => {
  // 침묵은 '예약 없음'과 'cron이 죽음'을 구분해주지 않는다.
  assertEquals(digest([], kst("07:00")).split("\n"), [
    "[타입라운지] 8/9(일) 청소 안내",
    "",
    "오늘 예약이 없어요. 청소는 편한 시간에 하시면 됩니다.",
  ]);
});

Deno.test("빈 값은 조각째 빠진다 — 빈칸이 새지 않는다", () => {
  const body = digest([res("a", "09:00", "12:00", { guests: null, purpose: null })], kst("07:00"));
  assertStringIncludes(body, "09:00–12:00 김민수\n");
  assertEquals(body.includes("· \n"), false);
  assertEquals(body.includes("null"), false);
});

Deno.test("연락처는 본문에 없다", () => {
  // 청소에 쓸 일이 없고, 안 실으면 안 새는 값이다.
  const body = digest([res("a", "09:00", "12:00", { name: "김민수" })], kst("07:00"));
  assertEquals(/01[016789]/.test(body), false);
});

Deno.test("어제에서 넘어온 예약에 (어제)가 붙는다", () => {
  const body = digest([
    res("y", "22:00", "02:00", { date: "2026-08-08" }),
    res("a", "14:00", "18:00", { name: "윤단비", guests: 8, purpose: "회의" }),
  ], kst("07:00"));
  assertStringIncludes(body, "(어제) 22:00–02:00 김민수 6명");
  // 넘어온 예약이 첫 창의 시작을 밀었다는 사실이 목록으로 설명된다
  assertStringIncludes(body, "07:00–14:00");
});

Deno.test("자정을 넘겨 끝나면 마지막 창에 '내일'이 붙는다", () => {
  const body = digest([res("a", "22:00", "02:00")], kst("21:00"));
  assertStringIncludes(body, "내일 02:00 이후");
});

Deno.test("길이는 분이 아니라 시간으로 읽힌다", () => {
  const body = digest([res("a", "15:30", "18:00")], kst("07:00"));
  assertStringIncludes(body, "07:00–15:30 (8시간 30분)"); // 480분보다 낫다
});

Deno.test("붙어 있는 예약은 분 대신 '붙어 있어'로 적는다", () => {
  const body = digest([res("a", "09:00", "12:00"), res("b", "12:00", "15:00")], kst("07:00"));
  assertStringIncludes(body, "⚠️ 12:00→12:00 사이는 붙어 있어 청소 시간이 없어요");
});

Deno.test("변경 안내 — 추가·취소·변경과 재계산된 청소 창", () => {
  const now = kst("12:30");
  const before = buildSnapshot([
    res("a", "09:00", "12:00"),
    res("b", "13:00", "17:00", { name: "윤단비", guests: 8 }),
  ], now);
  const after = [
    res("b", "13:00", "19:00", { name: "윤단비", guests: 8 }),
    res("c", "20:00", "22:00", { name: "박서준", guests: 5, purpose: "촬영" }),
  ];
  const diff = compare(before, buildSnapshot(after, now));
  const body = updateMessage(diff, remaining(planCleaning(after, now), now), now);

  assertEquals(body.split("\n"), [
    "[타입라운지] 8/9(일) 예약 변경",
    "",
    "+ 추가  20:00–22:00 박서준 5명 · 촬영",
    "− 취소  09:00–12:00 김민수",
    "↻ 변경  13:00–17:00 → 13:00–19:00 윤단비",
    "",
    "■ 청소 가능 (변경 후)",
    "12:30–13:00 (30분)", // 진행 중인 창은 지금부터
    "19:00–20:00 (1시간)",
    "22:00 이후",
  ]);
});

Deno.test("빽빽한 하루도 LMS 상한(2000바이트) 안에 들어간다 — 실발송 문자열로 잰다", () => {
  // SOLAPI LMS는 2000바이트다. 넘으면 벤더가 거절하는데 그 실패는 발송 시점에야 보인다.
  // 손님 문구와 달리 여기는 **길이가 그날 예약 수에 비례**해서 자라므로 상한을 재둔다.
  // 30분 간격으로 붙인 12건 — 전용 52.49㎡ 단일 공간에서 현실적으로 가능한 최대치를 넘는다.
  //
  // **다이제스트만 재면 실발송과 다른 것을 잰다.** 아침 문자는 dispatch.ts가 발송 직전에
  // `body + "\n\n" + accessBlock(...)`(smsOnly)을 합쳐 보낸다 — 상한을 넘는 날 가장 먼저
  // 거절되는 것이 하필 비밀번호가 실린 그 한 통이므로, 합산 문자열로 잰다.
  const packed = Array.from({ length: 12 }, (_, i) => {
    const h = String(8 + i).padStart(2, "0");
    return res(`r${i}`, `${h}:00`, `${h}:20`, { name: "홍길동", guests: 8, purpose: "촬영 스튜디오" });
  });
  // 픽스처 값은 실값과 무관하게 자릿수만 맞춘다 — 어드민은 상한 없는 값의 현실적 최대치로 16자.
  const smsText = `${digest(packed, kst("07:00"))}\n\n${accessBlock("0000000", "X".repeat(16))}`;
  const bytes = new TextEncoder().encode(smsText).length;
  assertEquals(bytes < 2000, true, `${bytes}바이트`);
});

// ── 출입·어드민 안내 블록 ──

// 픽스처 값은 실값과 무관하게 짓는다. 특히 어드민 픽스처를 현관 값의 재배열로 짓지 않는다 —
// 20260817000000 주석이 경고하는 바로 그 패턴("재배열이면 탐색 공간이 순열 수로 준다")을
// 테스트가 예시로 보여주면, 예시가 관행이 된다.
Deno.test("접근 안내 — 현관과 어드민이 한 블록에 담긴다", () => {
  const b = accessBlock("7204863", "TL-adm-2468");
  assertStringIncludes(b, "현관 비밀번호 7204863");
  assertStringIncludes(b, "비밀번호 TL-adm-2468");
  assertStringIncludes(b, "/admin");
  assertStringIncludes(b, "외부에 공유하지 말아 주세요");
});

/**
 * 어드민 비밀번호가 없는 상태(시크릿 미설정)에서도 현관 안내는 나가야 한다 — 담당자가 문을
 * 못 여는 것이 조명을 못 켜는 것보다 먼저 막힌다. 빈 줄로 '비밀번호 ' 만 나가면 담당자가
 * 값이 지워진 줄 알고 연락하게 된다.
 */
Deno.test("어드민 비밀번호가 없으면 그 블록만 빠진다 — 현관은 남는다", () => {
  const b = accessBlock("7204863", null);
  assertStringIncludes(b, "현관 비밀번호 7204863");
  assertEquals(b.includes("어드민"), false);
  assertEquals(b.includes("비밀번호 null"), false);
  assertEquals(/비밀번호 $/m.test(b), false);
});

/**
 * **이 블록은 다이제스트 본문에 들어가면 안 된다.** 본문(`body`)은 문자·DB 장부·Mattermost
 * 세 곳으로 가므로, 여기 섞이면 비밀번호가 장부에 영구히 남고 채널에도 평문으로 올라간다.
 * 문자에 붙이는 일은 `dispatch.ts`가 발송 직전에만 한다(`Outgoing.smsOnly`).
 */
Deno.test("비밀번호는 다이제스트 본문에 없다 — 문자 발송 경로에서만 붙는다", () => {
  const body = digest([res("a", "09:00", "12:00")], kst("07:00"));
  // 값이 아니라 **블록의 표식**으로 잰다 — 값 문자열 검사는 픽스처가 바뀌면 헛것을 재고,
  // 진짜 값을 여기 적으면 테스트가 평문 보관처가 된다.
  assertEquals(body.includes("현관"), false);
  assertEquals(body.includes("어드민"), false);
  assertEquals(body.includes("비밀번호"), false);
});
