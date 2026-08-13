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
  const result = decideTransition(true, undefined, 0, OFFLINE, RECOVERED, NOW);
  assertEquals(result, "offline");
});

Deno.test("끊김이 이어지는 중 — backoff(60분) 안이면 조용히 넘어간다", () => {
  const latest: LatestEvent = { kind: OFFLINE, at: minutesAgo(30) };
  assertEquals(decideTransition(true, latest, 0, OFFLINE, RECOVERED, NOW), "none");
});

Deno.test("끊김이 이어지는 중 — backoff를 넘기면 다시 알린다", () => {
  const latest: LatestEvent = { kind: OFFLINE, at: minutesAgo(61) };
  assertEquals(decideTransition(true, latest, 0, OFFLINE, RECOVERED, NOW), "offline");
});

Deno.test("정상으로 돌아옴 — 직전이 끊김이었으면 복구를 알린다", () => {
  const latest: LatestEvent = { kind: OFFLINE, at: minutesAgo(3) };
  assertEquals(decideTransition(false, latest, 0, OFFLINE, RECOVERED, NOW), "recovered");
});

Deno.test("계속 정상 — 장부에 기록이 없으면 할 말이 없다", () => {
  assertEquals(decideTransition(false, undefined, 0, OFFLINE, RECOVERED, NOW), "none");
});

Deno.test("이미 복구를 알린 뒤 계속 정상 — 다시 알리지 않는다", () => {
  const latest: LatestEvent = { kind: RECOVERED, at: minutesAgo(2) };
  assertEquals(decideTransition(false, latest, 0, OFFLINE, RECOVERED, NOW), "none");
});

Deno.test("플래핑 — 복구 직후 바로 다시 끊기면 backoff와 무관하게 즉시 offline", () => {
  // 집합 소속만으로 판단했다면 이 기기가 'device_offline'과 'device_recovered' 양쪽 집합에
  // 걸쳐 있어 두 번째 끊김을 놓칠 수 있다. 최신 한 건(복구)만 보므로 놓치지 않는다.
  const latest: LatestEvent = { kind: RECOVERED, at: minutesAgo(1) };
  assertEquals(decideTransition(true, latest, 0, OFFLINE, RECOVERED, NOW), "offline");
});

Deno.test("카메라 kind 쌍에도 동일하게 동작한다 — kind 이름 자체엔 의존하지 않는다", () => {
  const latest: LatestEvent = { kind: "camera_offline", at: minutesAgo(90) };
  assertEquals(
    decideTransition(true, latest, 0, "camera_offline", "camera_recovered", NOW),
    "offline",
  );
});

// ── 플래핑 상한 (FLAP_WINDOW 60분 / FLAP_CAP 4) ──────────────────────────────
//
// 여기가 이 기능의 새 경계다. 상한이 너무 낮으면 진짜 장애를 놓치고, 없으면 끊김↔복구가
// 반복될 때 사이클마다 알림 2건이 무한정 쌓인다(조명은 그 반복이 실제로 일어나는 환경이다).

Deno.test("플래핑 상한 — 창 안에 끊김이 상한만큼 쌓였으면 새 끊김을 삼킨다", () => {
  const latest: LatestEvent = { kind: RECOVERED, at: minutesAgo(1) };
  assertEquals(decideTransition(true, latest, 4, OFFLINE, RECOVERED, NOW), "none");
  assertEquals(decideTransition(true, latest, 9, OFFLINE, RECOVERED, NOW), "none");
});

Deno.test("플래핑 상한 — 상한 직전(3건)까지는 여전히 알린다", () => {
  // 경계에서 한 칸 모자란 값이 조용해지면, 실제로는 상한이 3이라는 뜻이다.
  const latest: LatestEvent = { kind: RECOVERED, at: minutesAgo(1) };
  assertEquals(decideTransition(true, latest, 3, OFFLINE, RECOVERED, NOW), "offline");
});

// 첫 끊김(장부 없음)에 상한이 걸리는 경우는 **일어날 수 없어서** 테스트하지 않는다.
// 두 값이 같은 장부에서 오되 창이 겹쳐 있기 때문이다: latest는 24시간(LOOKBACK_HOURS),
// 카운트는 60분(FLAP_WINDOW_MINUTES)을 본다. 60분 창에 끊김이 하나라도 있으면 그건 24시간
// 창에도 있으므로 latest가 반드시 채워진다 — 즉 `latest === undefined`면 카운트는 0이다.
// (이 포함 관계가 깨지면, 즉 FLAP_WINDOW가 LOOKBACK보다 길어지면 첫 끊김이 조용히 삼켜진다.
//  그때는 여기 주석이 아니라 connectivity.ts의 두 상수를 다시 봐야 한다.)

Deno.test("플래핑 상한 — 이어지는 끊김의 60분 재알림은 상한이 막지 않는다", () => {
  // 장기 장애는 전환이 드물어 상한에 닿지 않아야 한다. 이 경로는 상한을 아예 안 본다.
  const latest: LatestEvent = { kind: OFFLINE, at: minutesAgo(61) };
  assertEquals(decideTransition(true, latest, 99, OFFLINE, RECOVERED, NOW), "offline");
});

Deno.test("플래핑 상한 — 복구 알림은 상한과 무관하다", () => {
  // 끊김만 억제한다. 복구까지 삼키면 장부의 마지막 판정이 '끊김'으로 굳어,
  // 다음 진짜 끊김이 '이어지는 중'으로 오해돼 60분을 기다리게 된다.
  const latest: LatestEvent = { kind: OFFLINE, at: minutesAgo(3) };
  assertEquals(decideTransition(false, latest, 99, OFFLINE, RECOVERED, NOW), "recovered");
});
