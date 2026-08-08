/**
 * `message.ts`의 메시지 조립 테스트 — 발송(fetch)은 건드리지 않는다.
 *
 * 여기서 검증하는 것은 **묶는 규칙**이다. 명령 하나에 알림 하나면 채널을 못 쓰게 되므로,
 * 묶기가 깨지는 것이 이 기능의 가장 현실적인 실패 방식이다.
 *
 * 실행: `deno test supabase/functions/control/automation/message.test.ts`
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildMessage, orderGroups } from "./message.ts";
import type { EventKind, EventRow } from "./events.ts";

const NAMES = new Map([
  ["ac", "에어컨"],
  ["l1", "메인 조명"],
  ["l2", "SiHAS 조명"],
]);

let seq = 0;
function ev(p: Partial<EventRow> & { device_id: string | null }): EventRow {
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

function byKind(entries: Array<[EventKind, EventRow[]]>): Map<EventKind, EventRow[]> {
  return new Map(entries);
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
  const msg = buildMessage("prep", [
    ev({ device_id: "ac", action: "set_mode", value: "COOL", status: "failed", detail: "거부" }),
    ev({ device_id: "ac", action: "set_temp", value: "26" }),
  ], NAMES);
  // 모드는 실패해도 사람말로 찍힌다 — '모드'보다 '냉방'이 무엇을 시도했는지를 더 잘 말한다.
  assertStringIncludes(msg, "❌ 냉방 — 거부");
});

Deno.test("손님이 온도를 여러 번 눌러도 한 줄, 최종값만", () => {
  const msg = buildMessage("remote_guest", [
    ev({ device_id: "ac", kind: "remote_guest", action: "set_temp", value: "26" }),
    ev({ device_id: "ac", kind: "remote_guest", action: "set_temp", value: "24" }),
    ev({ device_id: "ac", kind: "remote_guest", action: "set_temp", value: "22" }),
  ], NAMES);
  assertEquals(msg.split("\n").filter((l) => l.startsWith("| 에어컨")).length, 1);
  assertStringIncludes(msg, "| 에어컨 | 22도 |");
});

Deno.test("현장 조작은 관측 '구간'을 보여준다 — 알아챈 시각 하나가 아니라", () => {
  // 빈 시간엔 10분에 한 번만 관측하므로 `at`은 실제 조작보다 한참 뒤일 수 있다. 시각 하나로
  // 찍으면 사람이 자기 행동과 대조하다 틀린다 — 2026-08-08의 '꺼짐 → 켜짐 (08:47)'이
  // 방향이 뒤집힌 것 아니냐는 의심을 받았다 — 방향은 기준선과 판독값 그대로였다.
  const msg = buildMessage("onsite", [
    ev({
      device_id: "ac",
      kind: "onsite",
      action: "observed",
      value: "전원 꺼짐 → 켜짐",
      detail: "2026-08-09T23:37:00.000Z", // 기준선을 뜬 시각 = 08:37 KST
      at: "2026-08-09T23:47:01.000Z", // 알아챈 시각 = 08:47 KST
    }),
  ], NAMES);

  assertStringIncludes(msg, "전원 꺼짐 → 켜짐");
  assertStringIncludes(msg, "(08:37~08:47 사이)");
});

Deno.test("기준선 시각이 없으면 알아챈 시각만 적는다", () => {
  const msg = buildMessage("onsite", [
    ev({ device_id: "l1", kind: "onsite", action: "observed", value: "전원 꺼짐 → 켜짐" }),
  ], NAMES);
  assertStringIncludes(msg, "(19:00)");
  assertEquals(msg.includes("사이"), false);
});

Deno.test("현장 조작은 합치지 않는다 — 네 번 만진 건 네 줄이다", () => {
  // set_temp 연타는 마지막이 최종 상태라 합쳐도 되지만, 현장 조작은 각각이 별개의 사람
  // 행위다. 합치면 스위치를 네 번 만진 것이 한 번으로 읽힌다.
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

Deno.test("전환 자체가 못 돈 것은 '공간 전체' 한 줄로, 사유만 보인다", () => {
  // 기기를 하나 골라 적으면 거짓이고, 전 기기에 하나씩 적으면 실패 한 건이 표 여섯 줄이 된다.
  // '켜기 — ...'처럼 액션을 붙이면 시도는 했다는 것처럼 읽히므로 사유만 남긴다.
  const msg = buildMessage("shutdown", [
    ev({
      device_id: null,
      kind: "shutdown",
      action: "shutdown",
      status: "failed",
      detail: "퇴실 종료 시각을 10분 넘겨 실행하지 못했습니다",
    }),
  ], NAMES);

  assertStringIncludes(msg, "⚠️");
  assertStringIncludes(msg, "| 공간 전체 | ❌ 퇴실 종료 시각을 10분 넘겨 실행하지 못했습니다 |");
  assertEquals(msg.includes("끄기 —"), false);
});

Deno.test("유휴 경보는 status가 ok라도 제목이 스스로 경고를 단다", () => {
  // 아무 명령도 실패하지 않았으므로 '실패 포함' 규칙에 걸리지 않는다. 그런데 이건
  // 냉난방이 밤새 도는 신호라 반드시 눈에 띄어야 한다.
  const msg = buildMessage("idle", [
    ev({ device_id: "ac", kind: "idle", action: "observed", value: "켜짐" }),
  ], NAMES);

  assertStringIncludes(msg, "⚠️ 예약 없이 켜져 있음");
  assertEquals(msg.includes("실패 포함"), false);
  assertStringIncludes(msg, "| 에어컨 | 켜짐 |");
});

Deno.test("알림은 종류 중요도가 아니라 일어난 순서로 나간다", () => {
  // 채널은 발송 순서가 곧 타임라인이다. 중요도순으로 보내면 손님이 조명을 켠 것(먼저)보다
  // 스윕이 끈 것(나중)이 위에 올라와 시간이 거꾸로 읽힌다 — 실제로 이렇게 나갔다(2026-08-08).
  const groups = byKind([
    ["sweep", [ev({ device_id: "l1", kind: "sweep", at: "2026-08-08T01:00:01.000Z" })]],
    ["remote_guest", [ev({ device_id: "l1", kind: "remote_guest", at: "2026-08-08T00:59:41.000Z" })]],
  ]);

  assertEquals(orderGroups(groups).map(([k]) => k), ["remote_guest", "sweep"]);
});

Deno.test("묶음의 순서 기준은 그 묶음의 마지막 이벤트다", () => {
  // 표시 시각도 마지막 이벤트를 쓴다. 둘이 다른 값을 쓰면 발송 순서와 화면의 시각이 어긋난다.
  const groups = byKind([
    ["remote_guest", [
      ev({ device_id: "ac", kind: "remote_guest", at: "2026-08-08T00:00:00.000Z" }),
      ev({ device_id: "ac", kind: "remote_guest", at: "2026-08-08T00:10:00.000Z" }), // 늦음
    ]],
    ["sweep", [ev({ device_id: "l1", kind: "sweep", at: "2026-08-08T00:05:00.000Z" })]],
  ]);

  // 첫 이벤트로 정렬했다면 remote_guest(00:00)가 먼저지만, 마지막 기준이면 sweep(00:05)이 먼저다.
  assertEquals(orderGroups(groups).map(([k]) => k), ["sweep", "remote_guest"]);
});

Deno.test("조명의 '큐에만 넣음'을 매번 적지 않는다", () => {
  // 조명 명령엔 항상 붙어 있어서 정보가 되지 않았다. 정말 안 된 경우는
  // 스윕 창 종료 시 실패 이벤트로 따로 드러난다.
  const msg = buildMessage("shutdown", [
    ev({ device_id: "l1", action: "power_off", detail: "sent" }),
  ], NAMES);
  assertEquals(msg.includes("반영 미확인"), false);
  assertStringIncludes(msg, "| 메인 조명 | 끄기 |");
});

Deno.test("반영되지 않은 것은 실패로 드러난다", () => {
  const msg = buildMessage("sweep", [
    ev({
      device_id: "l1",
      kind: "sweep",
      action: "power_off",
      status: "failed",
      detail: "퇴실 후 10분간 껐는데도 켜져 있습니다",
    }),
  ], NAMES);
  assertStringIncludes(msg, "⚠️");
  assertStringIncludes(msg, "껐는데도 켜져 있습니다");
});

Deno.test("표가 길어지면 자르고, 자른 사실을 남긴다", () => {
  // 건수 상한(200)만으로는 길이를 못 막는다 — 현장 조작은 합치지 않아 200건이 곧 200줄이다.
  // 길이로 거절당하면 그 묶음이 큐의 머리에 눌러앉아 뒤의 알림까지 막는다.
  const rows = Array.from({ length: 200 }, (_, i) =>
    ev({
      device_id: "ac",
      kind: "onsite",
      action: "observed",
      value: `전원 꺼짐 → 켜짐 · 온도 ${20 + (i % 10)}도 → ${21 + (i % 10)}도`,
    }));

  const msg = buildMessage("onsite", rows, NAMES);

  assert(msg.length <= 3500, `상한을 넘었다: ${msg.length}자`);
  assertStringIncludes(msg, "건 생략 (길이 상한)");
});

Deno.test("자를 땐 실패 줄이 먼저 남는다", () => {
  // 잘려도 되는 건 잘 된 줄이지 안 된 줄이 아니다.
  // 기기를 전부 다르게 둔다 — sweep은 기기별로 묶으므로 같은 id로 두면 한 줄로 합쳐져 길이가 안 찬다.
  const ok = Array.from({ length: 200 }, (_, i) =>
    ev({ device_id: `d${i}`, kind: "sweep", action: "power_off" }));
  const failed = ev({
    device_id: "ac",
    kind: "sweep",
    action: "power_off",
    status: "failed",
    detail: "퇴실 후 10분간 껐는데도 켜져 있습니다",
  });

  // 실패를 맨 뒤에 둔다 — 순서대로 자르면 가장 먼저 잘려나갈 자리다.
  const msg = buildMessage("sweep", [...ok, failed], NAMES);

  assert(msg.length <= 3500, `상한을 넘었다: ${msg.length}자`);
  assertStringIncludes(msg, "껐는데도 켜져 있습니다");
});
