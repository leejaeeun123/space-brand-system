/**
 * tasmota-http.js 회귀 방지 — 단일 책임: 실패가 'OFF'로 둔갑하지 않는지 확인한다.
 *
 * fetch를 갈아끼워 돌린다. 실기기도 LAN도 필요 없고, 실제 타임아웃(4초)을 기다리지도
 * 않는다 — 즉시 거절하거나 500을 돌려주는 것으로 같은 코드 경로를 밟는다.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { rememberDeviceIp } from "../src/device-ips.js";
import { pollHttpState, sendHttpCommand } from "../src/tasmota-http.js";

const CACHE_PATH = fileURLToPath(new URL("../.device-ips.json", import.meta.url));

const realFetch = global.fetch;
const realError = console.error;
let errors = [];
/** 이 테스트가 현장 맥의 IP 캐시를 지우면 안 된다. 있던 내용을 그대로 되돌려 놓는다. */
let savedCache = null;

test.before(async () => {
  savedCache = await fs.readFile(CACHE_PATH, "utf8").catch(() => null);
});

test.beforeEach(() => {
  errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  rememberDeviceIp("test-light", "192.168.200.99");
});

test.afterEach(() => {
  global.fetch = realFetch;
  console.error = realError;
});

test.after(async () => {
  if (savedCache === null) await fs.rm(CACHE_PATH, { force: true }).catch(() => {});
  else await fs.writeFile(CACHE_PATH, savedCache).catch(() => {});
});

test("타임아웃/네트워크 오류: power는 OFF를 지어내지 않고, online만 false로 내리고 로그를 남긴다", async () => {
  global.fetch = async () => {
    throw new Error("The operation was aborted due to timeout");
  };

  const state = await pollHttpState("test-light");
  // power에 'OFF'를 지어내면 '못 읽었다'가 '꺼졌다'로 둔갑한다 — online만 내린다.
  // reported:false는 "기기 보고가 아니다"의 표식 — 이게 없으면 실패 관측이 reported_at을
  // 갱신해, 무응답 기기의 상태가 화면에서 방금 것처럼 보인다.
  assert.deepEqual(state, { online: false, power: null, reported: false });

  const sent = await sendHttpCommand("test-light", "POWER ON");
  assert.equal(sent.ok, false);
  assert.equal(sent.power, null);
  assert.match(sent.reason, /HTTP 실패/);

  assert.equal(errors.length, 2, "실패는 조용히 삼키지 않고 console.error로 남긴다");
  assert.ok(errors.every((e) => e.includes("test-light")));
});

test("비 2xx 응답도 실패로 다룬다 — power는 안 쓰고 online만 false", async () => {
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ POWER: "OFF" }) });

  assert.deepEqual(await pollHttpState("test-light"), {
    online: false,
    power: null,
    reported: false,
  });
  const sent = await sendHttpCommand("test-light", "POWER ON");
  assert.equal(sent.ok, false);
  // 본문에 OFF가 있어도 500이면 읽지 않는다. 실패한 응답의 본문은 근거가 아니다.
  assert.equal(sent.power, null);
  assert.ok(errors.some((e) => e.includes("HTTP 500")));
});

test("깨진 JSON도 실패로 다룬다", async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  });

  assert.deepEqual(await pollHttpState("test-light"), {
    online: false,
    power: null,
    reported: false,
  });
  assert.equal(errors.length, 1);
});

test("전원값이 없는 응답은 '진짜 모름'이라 null을 돌려준다(online도 단정하지 않는다)", async () => {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ StatusSTS: {} }) });

  // 기기가 응답은 했다(요청 자체는 실패가 아니다) — 그래도 전원값이 없으면 online:false로도
  // 단정하지 않는다. '응답 없음'과 '응답은 왔는데 못 읽음'은 다른 문제다.
  assert.equal(await pollHttpState("test-light"), null);
  assert.ok(errors.some((e) => e.includes("전원값이 없습니다")));
});

test("IP를 모르면 요청 자체를 안 하고, 이유를 구분해서 돌려준다", async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error("호출되면 안 된다");
  };

  const sent = await sendHttpCommand("아직-모르는-기기", "POWER ON");
  assert.equal(called, false);
  assert.equal(sent.ok, false);
  // 'IP 모름'과 'HTTP 실패'는 고칠 방법이 다르다 — 명령 실패 사유에 그대로 남는다.
  assert.equal(sent.reason, "IP 모름");

  // 상태 조회 쪽도 같은 이유로 online:false — IP를 몰라 확인할 방법이 아예 없는 것도
  // '지금 확인 안 됨'이라는 점에서 응답 없음과 같은 취급이다.
  assert.deepEqual(await pollHttpState("아직-모르는-기기"), {
    online: false,
    power: null,
    reported: false,
  });
});

test("성공하면 기기가 답한 실제 전원값을 돌려준다", async () => {
  global.fetch = async (url) => {
    assert.equal(String(url), "http://192.168.200.99/cm?cmnd=POWER+ON");
    return { ok: true, status: 200, json: async () => ({ POWER: "ON" }) };
  };

  const sent = await sendHttpCommand("test-light", "POWER ON");
  assert.deepEqual(sent, { ok: true, reason: null, power: "ON" });
  assert.equal(errors.length, 0);
});
