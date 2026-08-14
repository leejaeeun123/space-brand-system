/**
 * state.js 회귀 방지 — 단일 책임: '모름을 OFF로 합치지 않는다'는 규칙을 못에 박는다.
 *
 * 이 규칙은 코드에 있었지만 테스트가 없었다. 없으면 다음 사람이 "power가 null이면 꺼진 거
 * 아닌가" 하고 한 줄 고쳐도 아무 경고가 안 뜬다. 그 한 줄이 켜진 조명을 화면에서 지운다.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractPower, mergeState, parsePayload } from "../src/state.js";

test("mergeState: 모르는 전원값('모름')은 마지막 값을 지우지 않는다", () => {
  // 실제로 일어나는 모양: 기기가 끊겨 LWT가 온다. online만 알고 power는 모른다.
  const merged = mergeState({ online: true, power: "ON" }, { online: false, power: null });
  assert.equal(merged.power, "ON");
  assert.notEqual(merged.power, "OFF");
  assert.equal(merged.online, false);
});

test("mergeState: STATUS5 델타(전원 모름)도 마지막 전원값을 보존한다", () => {
  // 재접속마다 STATUS5가 오므로 이 경로가 가장 자주 밟힌다.
  const delta = parsePayload("STATUS5", JSON.stringify({ StatusNET: { IPAddress: "192.168.200.31" } }));
  const merged = mergeState({ online: true, power: "ON" }, delta);
  assert.equal(merged.power, "ON");
});

test("mergeState: 상태를 한 번도 못 받았으면 power는 null이지 'OFF'가 아니다", () => {
  const merged = mergeState(null, { online: true, power: null });
  assert.equal(merged.power, null);
});

test("mergeState: 실제 전원 보고는 그대로 반영된다", () => {
  const merged = mergeState({ online: true, power: "ON" }, { online: true, power: "OFF" });
  assert.equal(merged.power, "OFF");
});

test("parsePayload STATUS5: IPAddress를 뽑고 전원은 모름으로 둔다", () => {
  const delta = parsePayload(
    "STATUS5",
    JSON.stringify({ StatusNET: { IPAddress: "192.168.200.31", Gateway: "192.168.200.1" } }),
  );
  assert.deepEqual(delta, { online: true, power: null, ip: "192.168.200.31" });
});

test("parsePayload STATUS5: 깨졌거나 IP가 없으면 null", () => {
  assert.equal(parsePayload("STATUS5", "{"), null);
  assert.equal(parsePayload("STATUS5", JSON.stringify({ StatusNET: {} })), null);
  assert.equal(parsePayload("STATUS5", JSON.stringify({ StatusNET: { IPAddress: "" } })), null);
  assert.equal(parsePayload("STATUS5", JSON.stringify({})), null);
});

test("parsePayload: 모르는 서브토픽은 여전히 null이다(기존 동작 유지)", () => {
  assert.equal(parsePayload("SENSOR", JSON.stringify({ Temperature: 21 })), null);
  assert.equal(parsePayload("STATUS11", JSON.stringify({ StatusSTS: { POWER: "ON" } })), null);
  assert.equal(parsePayload("POWER", "MAYBE"), null);
});

test("parsePayload: 기존 LWT·POWER·RESULT 동작은 그대로다", () => {
  assert.deepEqual(parsePayload("LWT", "Offline"), { online: false, power: null });
  assert.deepEqual(parsePayload("POWER", "ON"), { online: true, power: "ON" });
  assert.deepEqual(parsePayload("RESULT", JSON.stringify({ POWER: "OFF" })), {
    online: true,
    power: "OFF",
  });
});

test("extractPower: 세 가지 응답 모양을 모두 읽고, 모르면 null", () => {
  assert.equal(extractPower({ POWER: "ON" }), "ON");
  assert.equal(extractPower({ POWER1: "OFF" }), "OFF");
  assert.equal(extractPower({ StatusSTS: { POWER: "ON" } }), "ON");
  // 모름은 null이다. 여기서 'OFF'를 돌려주면 규칙이 무너진다.
  assert.equal(extractPower({ StatusSTS: {} }), null);
  assert.equal(extractPower(null), null);
  assert.equal(extractPower("ON"), null);
});
