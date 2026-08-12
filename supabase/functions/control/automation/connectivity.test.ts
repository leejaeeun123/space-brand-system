/**
 * `connectivity.ts`의 순수 판단 로직(`decideTransition`) 테스트 — DB 없이 플래핑을 검증한다.
 *
 * 이게 이 기능 전체의 정확성이다: 끊김→복구→끊김이 짧은 창 안에서 반복될 때도 두 번째
 * 끊김을 놓치지 않아야 "불안정하면 즉시 알림"이라는 요구가 지켜진다.
 *
 * 실행: `deno test supabase/functions/control/automation/connectivity.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import { decideTransition } from "./connectivity.ts";
import type { LatestEvent } from "./events.ts";

const NOW = new Date("2026-08-12T10:00:00.000Z");
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

const OFFLINE = "device_offline" as const;
const RECOVERED = "device_recovered" as const;

Deno.test("처음 끊긴 기기 — 장부에 아무 기록이 없으면 즉시 offline", () => {
  const result = decideTransition(true, undefined, OFFLINE, RECOVERED, NOW);
  assertEquals(result, "offline");
});

Deno.test("끊김이 이어지는 중 — backoff(60분) 안이면 조용히 넘어간다", () => {
  const latest: LatestEvent = { kind: OFFLINE, at: minutesAgo(30) };
  assertEquals(decideTransition(true, latest, OFFLINE, RECOVERED, NOW), "none");
});

Deno.test("끊김이 이어지는 중 — backoff를 넘기면 다시 알린다", () => {
  const latest: LatestEvent = { kind: OFFLINE, at: minutesAgo(61) };
  assertEquals(decideTransition(true, latest, OFFLINE, RECOVERED, NOW), "offline");
});

Deno.test("정상으로 돌아옴 — 직전이 끊김이었으면 복구를 알린다", () => {
  const latest: LatestEvent = { kind: OFFLINE, at: minutesAgo(3) };
  assertEquals(decideTransition(false, latest, OFFLINE, RECOVERED, NOW), "recovered");
});

Deno.test("계속 정상 — 장부에 기록이 없으면 할 말이 없다", () => {
  assertEquals(decideTransition(false, undefined, OFFLINE, RECOVERED, NOW), "none");
});

Deno.test("이미 복구를 알린 뒤 계속 정상 — 다시 알리지 않는다", () => {
  const latest: LatestEvent = { kind: RECOVERED, at: minutesAgo(2) };
  assertEquals(decideTransition(false, latest, OFFLINE, RECOVERED, NOW), "none");
});

Deno.test("플래핑 — 복구 직후 바로 다시 끊기면 backoff와 무관하게 즉시 offline", () => {
  // 집합 소속만으로 판단했다면 이 기기가 'device_offline'과 'device_recovered' 양쪽 집합에
  // 걸쳐 있어 두 번째 끊김을 놓칠 수 있다. 최신 한 건(복구)만 보므로 놓치지 않는다.
  const latest: LatestEvent = { kind: RECOVERED, at: minutesAgo(1) };
  assertEquals(decideTransition(true, latest, OFFLINE, RECOVERED, NOW), "offline");
});

Deno.test("카메라 kind 쌍에도 동일하게 동작한다 — kind 이름 자체엔 의존하지 않는다", () => {
  const latest: LatestEvent = { kind: "camera_offline", at: minutesAgo(90) };
  assertEquals(
    decideTransition(true, latest, "camera_offline", "camera_recovered", NOW),
    "offline",
  );
});
