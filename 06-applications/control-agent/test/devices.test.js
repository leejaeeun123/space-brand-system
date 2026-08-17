/**
 * devices.js 회귀 방지 — 단일 책임: reported_at이 "기기가 보고한 시각"이라는 정의를 지키는지.
 *
 * 실패한 HTTP 폴링(기기 보고 아님)이 reported_at을 갱신하면, 기기가 몇 시간째 무응답인데도
 * 화면의 '언제 적 상태인지'가 방금처럼 보인다 — 그 회귀를 여기서 잡는다.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DeviceRegistry } from "../src/devices.js";

/** upsert에 실제로 넘어간 행을 붙잡는 최소 가짜 클라이언트. */
function fakeSb(rows) {
  return {
    from: () => ({
      upsert: async (row) => {
        rows.push(row);
        return { error: null };
      },
    }),
  };
}

test("기기 보고(기본값)는 reported_at과 updated_at을 함께 찍는다", async () => {
  const rows = [];
  const registry = new DeviceRegistry(fakeSb(rows));

  await registry.saveState("dev-1", { online: true, power: "ON" });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].online, true);
  assert.equal(rows[0].power, "ON");
  assert.ok(rows[0].reported_at, "기기가 보고했으면 reported_at이 있어야 한다");
  assert.equal(rows[0].reported_at, rows[0].updated_at);
});

test("reported:false(폴링 실패 관측)는 reported_at을 아예 보내지 않는다", async () => {
  const rows = [];
  const registry = new DeviceRegistry(fakeSb(rows));

  await registry.saveState("dev-1", { online: false, power: "ON" }, { reported: false });

  assert.equal(rows.length, 1);
  // upsert 페이로드에 컬럼이 없어야 기존 행의 값이 유지된다 — null을 보내는 것과 다르다.
  // null을 보내면 마지막으로 진짜 보고받은 시각까지 지워버린다.
  assert.equal("reported_at" in rows[0], false);
  assert.ok(rows[0].updated_at, "행을 만진 시각(updated_at)은 그대로 찍는다");
  // 실패 관측이 내리는 건 online뿐 — power는 mergeState가 보존한 마지막 관측값 그대로다.
  assert.equal(rows[0].online, false);
  assert.equal(rows[0].power, "ON");
});
