/**
 * `notify.ts`의 메시지 조립 테스트 — 발송(fetch)은 건드리지 않는다.
 *
 * 여기서 검증하는 것은 **묶는 규칙**이다. 명령 하나에 알림 하나면 채널을 못 쓰게 되므로,
 * 묶기가 깨지는 것이 이 기능의 가장 현실적인 실패 방식이다.
 *
 * 실행: `deno test supabase/functions/control/automation/notify.test.ts`
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildMessage } from "./notify.ts";
import type { EventRow } from "./events.ts";

const NAMES = new Map([
  ["ac", "에어컨"],
  ["l1", "메인 조명"],
  ["l2", "SiHAS 조명"],
]);

let seq = 0;
function ev(p: Partial<EventRow> & { device_id: string }): EventRow {
  return {
    id: ++seq,
    at: "2026-08-10T10:00:00.000Z",
    kind: "prep",
    action: "power_on",
    value: null,
    status: "ok",
    detail: null,
    ...p,
  } as EventRow;
}

Deno.test("입실 준비 — 기기 여러 대가 표 한 장으로 묶인다", () => {
  const msg = buildMessage("prep", [
    ev({ device_id: "ac", action: "power_on" }),
    ev({ device_id: "ac", action: "set_mode", value: "COOL" }),
    ev({ device_id: "ac", action: "set_temp", value: "26" }),
    ev({ device_id: "l1", action: "power_on" }),
    ev({ device_id: "l2", action: "power_off" }),
  ], NAMES);

  assertStringIncludes(msg, "**자동 · 입실 준비**");
  // 기기당 한 줄 — 명령 5개가 줄 3개가 된다.
  assertEquals(msg.split("\n").filter((l) => l.startsWith("| 에어컨")).length, 1);
  assertEquals(msg.split("\n").filter((l) => l.startsWith("| 메인 조명")).length, 1);
  // 에어컨은 마지막 명령(26도)이 최종 상태다.
  assertStringIncludes(msg, "| 에어컨 | 26도 |");
});

Deno.test("실패가 하나라도 있으면 제목에 경고가 붙고 그 줄이 보인다", () => {
  const msg = buildMessage("shutdown", [
    ev({ device_id: "ac", action: "power_off", status: "failed", detail: "ThinQ 인증 실패" }),
    ev({ device_id: "l1", action: "power_off" }),
  ], NAMES);

  assertStringIncludes(msg, "⚠️");
  assertStringIncludes(msg, "실패 포함");
  assertStringIncludes(msg, "❌ 끄기 — ThinQ 인증 실패");
});

Deno.test("실패는 마지막 명령이 아니어도 반드시 보인다", () => {
  // 온도를 두 번 보냈고 첫 번째가 실패 — '마지막 것만 보여준다'로 뭉개면 실패가 사라진다.
  const msg = buildMessage("prep", [
    ev({ device_id: "ac", action: "set_temp", value: "26", status: "failed", detail: "거부됨" }),
    ev({ device_id: "ac", action: "set_temp", value: "26" }),
  ], NAMES);

  assertStringIncludes(msg, "❌");
  assertStringIncludes(msg, "거부됨");
});

Deno.test("손님이 온도를 여러 번 눌러도 한 줄, 최종값만", () => {
  const msg = buildMessage("remote_guest", [
    ev({ device_id: "ac", kind: "remote_guest", action: "set_temp", value: "25" }),
    ev({ device_id: "ac", kind: "remote_guest", action: "set_temp", value: "24" }),
    ev({ device_id: "ac", kind: "remote_guest", action: "set_temp", value: "22" }),
  ], NAMES);

  assertStringIncludes(msg, "**원격 조작 · 손님**");
  assertEquals(msg.split("\n").filter((l) => l.startsWith("| 에어컨")).length, 1);
  assertStringIncludes(msg, "| 에어컨 | 22도 |");
});

Deno.test("현장 조작은 변화 설명과 시각을 보여준다", () => {
  const msg = buildMessage("onsite", [
    ev({ device_id: "l1", kind: "onsite", action: "observed", value: "전원 꺼짐 → 켜짐" }),
  ], NAMES);

  assertStringIncludes(msg, "**현장 조작**");
  assertStringIncludes(msg, "메인 조명");
  assertStringIncludes(msg, "전원 꺼짐 → 켜짐");
});

Deno.test("현장 조작은 합치지 않는다 — 네 번 만진 건 네 줄이다", () => {
  // set_temp 연타는 마지막이 최종 상태라 합쳐도 되지만, 현장 조작은 각각이 별개의 사람
  // 행위다. 합치면 스위치를 네 번 만진 것이 한 번으로 읽힌다(백로그가 쌓였을 때 실제로 난다).
  const msg = buildMessage("onsite", [
    ev({ device_id: "l1", kind: "onsite", action: "observed", value: "전원 꺼짐 → 켜짐" }),
    ev({ device_id: "l1", kind: "onsite", action: "observed", value: "전원 켜짐 → 꺼짐" }),
    ev({ device_id: "l1", kind: "onsite", action: "observed", value: "전원 꺼짐 → 켜짐" }),
    ev({ device_id: "l1", kind: "onsite", action: "observed", value: "전원 켜짐 → 꺼짐" }),
  ], NAMES);

  assertEquals(msg.split("\n").filter((l) => l.startsWith("| 메인 조명")).length, 4);
});

Deno.test("모드는 사람말로 바뀐다 — 손님에게 COOL을 보여주지 않는다", () => {
  const msg = buildMessage("prep", [
    ev({ device_id: "ac", action: "set_mode", value: "COOL" }),
  ], NAMES);
  assertStringIncludes(msg, "냉방");
});

Deno.test("이름을 모르는 기기도 줄이 사라지지 않는다", () => {
  // 등록 해제된 기기의 이벤트가 남아 있을 수 있다. 줄을 빼면 알림이 조용히 비어 보인다.
  const msg = buildMessage("onsite", [
    ev({ device_id: "gone", kind: "onsite", action: "observed", value: "전원 켜짐 → 꺼짐" }),
  ], NAMES);
  assertStringIncludes(msg, "알 수 없는 기기");
});
