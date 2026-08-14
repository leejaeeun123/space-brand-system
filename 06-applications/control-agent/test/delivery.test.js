/**
 * delivery.js 회귀 방지 — 단일 책임: 2단계 판정과 '확인'의 정의를 못에 박는다.
 *
 * 브로커도 네트워크도 필요 없다. 판정이 입력만으로 결정되게 만든 이유가 이것이다 —
 * 실기기 없이 못 돌리는 규칙은 결국 안 돌리게 되고, 안 돌리는 테스트는 없는 것과 같다.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitConfirmation,
  decideDelivery,
  isSuperseded,
  markLatestCommand,
  noteDeviceReport,
  parseCommandTopic,
} from "../src/delivery.js";

test("Tier 1: 로컬 브로커가 없으면 기다리지 않고 바로 HTTP", () => {
  const d = decideDelivery({ localConnected: false });
  assert.equal(d.tier, 1);
  assert.equal(d.action, "http");
  // 확인 결과가 뭐든 로컬이 없으면 발행할 곳 자체가 없다 — Tier 1이 먼저 걸린다.
  assert.equal(decideDelivery({ localConnected: false, confirmed: true }).tier, 1);
  assert.equal(decideDelivery({ localConnected: false, confirmed: false }).action, "http");
});

test("Tier 2: 로컬 브로커가 있으면 우선 한 번 발행한다", () => {
  const d = decideDelivery({ localConnected: true });
  assert.equal(d.tier, 2);
  assert.equal(d.action, "publish");
});

test("Tier 2: 기기 보고로 확인되면 끝, 안 오면 HTTP로 다시 보낸다", () => {
  assert.equal(decideDelivery({ localConnected: true, confirmed: true }).action, "done");
  const missed = decideDelivery({ localConnected: true, confirmed: false });
  assert.equal(missed.tier, 2);
  assert.equal(missed.action, "http");
});

test("브릿지 상태는 판정에 안 섞인다 — 남은 인자를 줘도 결과가 안 바뀐다", () => {
  // 예전에는 `bridgeUp === false`면 발행을 건너뛰고 바로 HTTP였다. 지금은 mosquitto가
  // 같은 cmnd를 AWS로도 병렬 릴레이하므로 '브릿지 끊김'이 유실 확정이 아니다 — 그때
  // HTTP로 직행하면 AWS로 간 사본이 확인될 기회를 뺏는다. 이 테스트가 그 회귀를 막는다.
  for (const stray of [false, true, null]) {
    const d = decideDelivery({ localConnected: true, bridgeUp: stray });
    assert.equal(d.tier, 2, `bridgeUp=${stray}에서도 Tier 2여야 한다`);
    assert.equal(d.action, "publish", `bridgeUp=${stray}에서도 발행해야 한다`);
  }
});

test("parseCommandTopic: cmnd 토픽을 HTTP 문법으로 바꾼다", () => {
  assert.deepEqual(parseCommandTopic("cmnd/light-1/POWER", "ON"), {
    address: "light-1",
    cmnd: "POWER ON",
    expectPower: "ON",
  });
  // TOGGLE은 결과를 미리 모른다 — 전원 보고가 오기만 하면 확인으로 본다.
  assert.equal(parseCommandTopic("cmnd/light-1/POWER", "TOGGLE").expectPower, null);
  // 우리 문법이 아니면 우회할 방법이 없다.
  assert.equal(parseCommandTopic("stat/light-1/POWER", "ON"), null);
  assert.equal(parseCommandTopic("cmnd/light-1", "ON"), null);
});

test("awaitConfirmation: 기다리던 전원 보고가 오면 확인된다", async () => {
  const p = awaitConfirmation("light-a", "ON", 1_000);
  noteDeviceReport("light-a", "ON");
  assert.equal(await p, true);
});

test("awaitConfirmation: 시간 안에 아무 보고도 없으면 false", async () => {
  assert.equal(await awaitConfirmation("light-b", "ON", 20), false);
});

test("전원을 모르는 보고(LWT·STATUS5)는 확인으로 세지 않는다", async () => {
  // 재접속마다 STATUS5가 온다. 이걸 확인으로 세면 기기에 닿지도 않은 명령이 '확인됨'이 된다.
  const p = awaitConfirmation("light-c", "ON", 40);
  noteDeviceReport("light-c", null);
  noteDeviceReport("light-c", undefined);
  assert.equal(await p, false);
});

test("다른 전원값 보고로는 확인되지 않는다", async () => {
  const p = awaitConfirmation("light-d", "ON", 40);
  noteDeviceReport("light-d", "OFF");
  assert.equal(await p, false);
});

test("기다리는 것이 없을 때의 보고는 아무 일도 일으키지 않는다", () => {
  assert.doesNotThrow(() => noteDeviceReport("아무도-안-기다림", "ON"));
});

test("isSuperseded: 더 최신 명령이 왔으면 낡은 명령은 밀린다", () => {
  // OFF(T1) 다음 ON(T2)이 온 상황을 재현한다. OFF의 stat 확인이 유실돼 나중에
  // HTTP 우회를 시도하려 할 때, 이미 더 최신인 ON이 왔으므로 우회하면 안 된다.
  markLatestCommand("light-race", 1_000);
  markLatestCommand("light-race", 2_000);
  assert.equal(isSuperseded("light-race", 1_000), true, "낡은 OFF는 밀려야 한다");
  assert.equal(isSuperseded("light-race", 2_000), false, "최신 ON 자신은 밀리지 않는다");
});

test("markLatestCommand: 순서가 뒤바뀌어 도착해도 더 이른 시각으로 되돌리지 않는다", () => {
  markLatestCommand("light-reorder", 5_000);
  markLatestCommand("light-reorder", 3_000); // 늦게 도착했지만 더 이른 명령
  // 3000으로 되돌아갔다면 4000은 안 밀려야(false) 하지만, 5000이 여전히 최신이면 밀려야(true) 한다.
  assert.equal(isSuperseded("light-reorder", 4_000), true, "5000이 여전히 최신이어야 한다");
});

test("isSuperseded: 그 주소로 아직 아무 명령도 기록되지 않았으면 밀리지 않는다", () => {
  assert.equal(isSuperseded("light-never-seen", 1_000), false);
});
