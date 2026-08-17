/**
 * bridge-health.js 회귀 방지 — 단일 책임: HTTP 재동기화 판정이 세 상태(붙음/끊김/모름)를
 * 다르게 다루는지 확인한다.
 *
 * 예전 판정(`isBridgeUp() === false`)은 '모름'을 '재동기화 불필요'로 취급했다 — 브로커
 * 자체가 안 붙은 동안(모름이 이어지는 동안)은 stat도 안 오는데 HTTP 우회도 안 돌아,
 * 픽스가 메우려던 화면 얼어붙음이 그 경로로 그대로 남았다. 그 사각지대를 여기서 못 박는다.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  isBridgeUp,
  needsHttpResync,
  noteBridgeState,
  noteBridgeUnknown,
  shouldHttpPoll,
} from "../src/bridge-health.js";

// ── 순수 판정(shouldHttpPoll) — 시각을 인자로 움직인다 ──

test("끊김 확정(false)은 유예 없이 즉시 재동기화한다", () => {
  assert.equal(shouldHttpPoll(false, 0), true);
});

test("붙음(true)은 모름 시간과 무관하게 재동기화하지 않는다 — stat이 실시간으로 온다", () => {
  assert.equal(shouldHttpPoll(true, 10 * 60_000), false);
});

test("모름(null)은 유예를 넘겼을 때만 재동기화한다 — 재접속 직후의 수초짜리 모름은 거른다", () => {
  // retained 확정값이 오기 전의 짧은 창 — 아직 아니다.
  assert.equal(shouldHttpPoll(null, 30_000), false);
  // 유예(60초)를 넘겼다 — 브로커가 안 붙는 상황이고 stat도 못 오니 읽어야 한다.
  assert.equal(shouldHttpPoll(null, 60_000), true);
});

test("유예는 인자로 조절할 수 있다 — 판정 상수가 바뀌어도 테스트가 스펙을 남긴다", () => {
  assert.equal(shouldHttpPoll(null, 5_000, 10_000), false);
  assert.equal(shouldHttpPoll(null, 10_000, 10_000), true);
});

// ── 상태 전이(note* → needsHttpResync) — mqtt.js가 넣는 순서 그대로 밟는다 ──

test("확정값이 오면 모름 시계와 무관하게 확정값이 이긴다", () => {
  noteBridgeState(false);
  assert.equal(isBridgeUp(), false);
  assert.equal(needsHttpResync(), true, "끊김 확정은 즉시");

  noteBridgeState(true);
  assert.equal(isBridgeUp(), true);
  assert.equal(needsHttpResync(), false, "붙음이면 폴링하지 않는다");
});

test("연결 끊김(모름 전환)은 유예 뒤부터 재동기화로 넘어간다", () => {
  const t0 = Date.now();
  noteBridgeUnknown(t0);
  assert.equal(isBridgeUp(), null);
  assert.equal(needsHttpResync(t0 + 30_000), false, "모름 30초 — 아직 유예 안");
  assert.equal(needsHttpResync(t0 + 61_000), true, "모름 61초 — 브로커가 안 붙는 상황");
});
