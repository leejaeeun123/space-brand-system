/**
 * `occupancy.ts`의 순수 부분 — 퇴실 후 창에서 **알릴 것인가 마는가**의 판정만 본다.
 *
 * 이게 테스트할 값어치가 있는 이유는 두 방향의 고장이 모두 조용하기 때문이다.
 * 너무 좁으면(유예가 길거나 낡음 판정이 헐거우면) 사람이 남아 있어도 아무 일도 안 일어나고,
 * 너무 넓으면 **정상적으로 나가는 손님마다** 경고가 떠서 사람이 그 경고를 무시하는 법을 배운다.
 * 어느 쪽도 에러를 남기지 않는다.
 *
 * 실행: `deno test supabase/functions/control/automation/occupancy.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  decideOverdue,
  type MotionReading,
  OVERDUE_GRACE_MINUTES,
  overdueWindow,
} from "./occupancy.ts";

const NOW = new Date("2026-08-18T09:08:00+09:00"); // 퇴실(09:00) + 8분
const LOOK_FROM = new Date("2026-08-18T09:03:00+09:00"); // 퇴실 + 유예 3분

/** 관측이 방금 갱신된 행. 낡음 판정에 걸리지 않는다. */
function fresh(camera_id: string, last_motion_at: string | null): MotionReading {
  return { camera_id, last_motion_at, observed_at: NOW.toISOString() };
}

Deno.test("창 안에 움직임이 있으면 그 카메라를 집는다", () => {
  const d = decideOverdue([fresh("lounge-l", "2026-08-18T09:07:30+09:00")], LOOK_FROM, NOW);
  assertEquals(d.moved, ["lounge-l"]);
  assertEquals(d.unknown, []);
  assertEquals(d.latest?.toISOString(), new Date("2026-08-18T09:07:30+09:00").toISOString());
});

Deno.test("유예 안(퇴실 직후)의 움직임은 세지 않는다 — 나가는 중인 손님이다", () => {
  // 짐을 싸고 문으로 걸어가는 것이 라운지 카메라에 그대로 잡힌다. 이걸 세면
  // 정상 퇴실마다 경고가 뜬다. 이 한 줄이 OVERDUE_GRACE_MINUTES의 존재 이유다.
  const d = decideOverdue([fresh("lounge-l", "2026-08-18T09:01:00+09:00")], LOOK_FROM, NOW);
  assertEquals(d.moved, []);
  assertEquals(d.latest, null);
});

Deno.test("경계는 포함이다 — 유예가 끝나는 그 순간의 움직임은 센다", () => {
  // 이 한 줄이 '나가는 손님'과 '남아 있는 손님'을 가르는 경계다. 나중에 `<`를 `<=`로
  // 뒤집으면 경계 1초가 조용히 반대편으로 넘어가는데, 그건 테스트 없이는 아무도 모른다.
  assertEquals(decideOverdue([fresh("lounge-l", LOOK_FROM.toISOString())], LOOK_FROM, NOW).moved, [
    "lounge-l",
  ]);
  // 1초만 일러도 유예 안이다.
  const justBefore = new Date(LOOK_FROM.getTime() - 1000).toISOString();
  assertEquals(decideOverdue([fresh("lounge-l", justBefore)], LOOK_FROM, NOW).moved, []);
});

Deno.test("퇴실 이전의 움직임은 당연히 세지 않는다", () => {
  const d = decideOverdue([fresh("lounge-l", "2026-08-18T08:55:00+09:00")], LOOK_FROM, NOW);
  assertEquals(d.moved, []);
});

Deno.test("한 번도 움직임이 없었으면(null) 조용하다", () => {
  assertEquals(decideOverdue([fresh("lounge-l", null)], LOOK_FROM, NOW).moved, []);
});

Deno.test("관측이 낡으면 '없음'이 아니라 '모름'이다", () => {
  // 감시자가 죽은 채로 "아무도 없습니다"가 참이 되는 것을 막는 줄이다.
  // 낡은 행의 last_motion_at은 창보다 이를 수밖에 없어서, 안 거르면 조용히 '없음'에 섞인다.
  const stale: MotionReading = {
    camera_id: "lounge-l",
    last_motion_at: "2026-08-18T08:00:00+09:00",
    observed_at: "2026-08-18T09:00:00+09:00", // 8분 전 = 180초 초과
  };
  const d = decideOverdue([stale], LOOK_FROM, NOW);
  assertEquals(d.moved, []);
  assertEquals(d.unknown, ["lounge-l"]);
});

Deno.test("observed_at을 못 읽어도 '모름'으로 간다", () => {
  const broken: MotionReading = {
    camera_id: "lounge-l",
    last_motion_at: "2026-08-18T09:07:00+09:00",
    observed_at: "그런 시각 없음",
  };
  const d = decideOverdue([broken], LOOK_FROM, NOW);
  assertEquals(d.moved, []);
  assertEquals(d.unknown, ["lounge-l"]);
});

Deno.test("두 대 중 한 대만 움직였으면 그 한 대만 집는다", () => {
  const d = decideOverdue(
    [fresh("lounge-l", "2026-08-18T09:06:00+09:00"), fresh("lounge-r", null)],
    LOOK_FROM,
    NOW,
  );
  assertEquals(d.moved, ["lounge-l"]);
});

Deno.test("여러 대가 움직였으면 latest는 가장 최근이다", () => {
  const d = decideOverdue(
    [
      fresh("lounge-l", "2026-08-18T09:04:00+09:00"),
      fresh("lounge-r", "2026-08-18T09:07:45+09:00"),
    ],
    LOOK_FROM,
    NOW,
  );
  assertEquals(d.moved.sort(), ["lounge-l", "lounge-r"]);
  assertEquals(d.latest?.toISOString(), new Date("2026-08-18T09:07:45+09:00").toISOString());
});

Deno.test("낡은 대와 멀쩡한 대가 섞이면 둘 다 각자의 자리로 간다", () => {
  const d = decideOverdue(
    [
      fresh("lounge-l", "2026-08-18T09:07:00+09:00"),
      { camera_id: "lounge-r", last_motion_at: null, observed_at: "2026-08-18T09:00:00+09:00" },
    ],
    LOOK_FROM,
    NOW,
  );
  assertEquals(d.moved, ["lounge-l"]);
  assertEquals(d.unknown, ["lounge-r"]);
});

Deno.test("하루 넘게 끊긴 행은 '모름'도 아니다 — 감시를 접은 카메라의 잔행", () => {
  // 감시 구성은 현장 셸에 있어 DB는 감시를 뺀 카메라를 모른다. 잔행을 '모름'으로 치면
  // 그 카메라를 뺀 날부터 퇴실 창마다 stale 경보가 영영 반복된다 — 사람이 경보를 무시하는
  // 법을 배우는 바로 그 경로라, 판정에서 통째로 제외한다.
  const retired: MotionReading = {
    camera_id: "office",
    last_motion_at: "2026-08-17T09:00:00+09:00",
    observed_at: "2026-08-17T08:00:00+09:00", // 25시간 전
  };
  const d = decideOverdue([retired], LOOK_FROM, NOW);
  assertEquals(d.moved, []);
  assertEquals(d.unknown, []);
});

Deno.test("잔행과 멀쩡한 대가 섞이면 잔행만 조용히 빠진다", () => {
  const retired: MotionReading = {
    camera_id: "office",
    last_motion_at: null,
    observed_at: "2026-08-16T09:00:00+09:00", // 이틀 전
  };
  const d = decideOverdue([fresh("lounge-l", "2026-08-18T09:07:00+09:00"), retired], LOOK_FROM, NOW);
  assertEquals(d.moved, ["lounge-l"]);
  assertEquals(d.unknown, []);
});

Deno.test("낡음의 경계 — 180초 초과~하루 이내는 여전히 '모름'이다", () => {
  // 방금 끊긴 감시자는 사람이 알아야 할 사건이다. 잔행 제외가 이 신호까지 삼키면 안 된다.
  const stale: MotionReading = {
    camera_id: "lounge-l",
    last_motion_at: null,
    observed_at: new Date(NOW.getTime() - 10 * 60_000).toISOString(), // 10분 전
  };
  assertEquals(decideOverdue([stale], LOOK_FROM, NOW).unknown, ["lounge-l"]);
});

Deno.test("관측 행이 없으면 아무것도 나오지 않는다 — 감시자 미설치 상태", () => {
  const d = decideOverdue([], LOOK_FROM, NOW);
  assertEquals(d.moved, []);
  assertEquals(d.unknown, []);
});

Deno.test("overdueWindow — 보기 시작은 퇴실 + 유예다", () => {
  // 퇴실 09:00에서 8분 경과한 시점으로 계산한다.
  const { sweepStart, lookFrom, since } = overdueWindow(8, NOW);
  assertEquals(sweepStart.toISOString(), new Date("2026-08-18T09:00:00+09:00").toISOString());
  assertEquals(
    lookFrom.getTime() - sweepStart.getTime(),
    OVERDUE_GRACE_MINUTES * 60_000,
  );
  // 중복 조회 기준은 창 시작보다 30초 이르다 — 틱이 창 시작에 정확히 맞춰 돌지 않기 때문이고,
  // 여유가 없으면 직전 알림 행을 놓쳐 같은 창에서 두 번 알린다(enforce.ts에서 가져온 값).
  assertEquals(sweepStart.getTime() - since.getTime(), 30_000);
});
