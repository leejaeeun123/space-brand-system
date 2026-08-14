/**
 * `enforce.ts`의 순수 부분 — 온도 하한을 **거는가 마는가**의 판정만 본다.
 *
 * 이게 테스트할 값어치가 있는 이유: 이 함수가 거짓이면 그 기기의 하한이 통째로 안 돈다.
 * 그 고장은 에러도 로그도 남기지 않고 **온도만 안 돌아온다.** 2026-08-13에 모드 조건이
 * 들어오면서 제습이 빠져 있었던 것이 그 모양이었다 — 손님이 제습 18도로 두면 하한이 있는
 * 줄 알고 있는데 아무 일도 일어나지 않는다. 실제로 밟은 사람이 있었다는 증거는 없고,
 * `FLOOR_MODES`를 기기 모드 목록과 대조해 발견했다. 반대로 너무 넓으면 HEAT 20도로 둔
 * 손님에게 24도를 밀어 난방을 세게 만든다.
 *
 * 실행: `deno test supabase/functions/control/automation/enforce.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import { floorApplies } from "./enforce.ts";

Deno.test("냉방 22도 가동 — 하한을 건다", () => {
  assertEquals(floorApplies("ON", "COOL", 22), true);
});

Deno.test("제습 18도도 하한을 건다 — 압축기가 도는 것은 냉방과 같다", () => {
  // 2026-08-15 추가. 이 기기의 모드 목록엔 AUTO가 없어, 제습이 '낮은 온도로 오래 트는'
  // 유일한 다른 경로다. 여기가 거짓이면 하한을 우회하는 길이 손님 화면 버튼 하나로 열린다.
  assertEquals(floorApplies("ON", "AIR_DRY", 18), true);
});

Deno.test("냉·난방 자동 선택(AUTO)도 건다", () => {
  // 지금 기기 프로파일엔 없다. 기기가 바뀔 때를 위해 남겨 둔 값이라 조건도 같이 남긴다.
  assertEquals(floorApplies("ON", "AUTO", 20), true);
});

Deno.test("난방·송풍·공기청정에는 걸지 않는다", () => {
  // HEAT 20도에 24도를 밀면 난방이 더 세져 하한의 목적과 정반대가 된다.
  assertEquals(floorApplies("ON", "HEAT", 20), false);
  assertEquals(floorApplies("ON", "FAN", 20), false);
  assertEquals(floorApplies("ON", "AIR_CLEAN", 20), false);
});

Deno.test("모드를 모르면 걸지 않는다", () => {
  // 상태를 못 읽은 틱에 HEAT를 미는 위험이, 과냉방을 한 틱 놓치는 것보다 크다.
  assertEquals(floorApplies("ON", undefined, 20), false);
  assertEquals(floorApplies("ON", null, 20), false);
});

Deno.test("전원이 ON이 아니면 걸지 않는다 — null('모름')도 ON이 아니다", () => {
  // 꺼진 기기의 목표온도는 아무 일도 하지 않는다. 요구사항이 "5분간 **가동**하다"이다.
  assertEquals(floorApplies("OFF", "COOL", 20), false);
  assertEquals(floorApplies(null, "COOL", 20), false);
  assertEquals(floorApplies(undefined, "COOL", 20), false);
});

Deno.test("하한 이상이면 걸지 않는다 — 정확히 24도는 되돌릴 것이 없다", () => {
  // `<=`로 두면 매 틱 같은 값을 다시 쓰는 명령이 나간다.
  assertEquals(floorApplies("ON", "COOL", 24), false);
  assertEquals(floorApplies("ON", "COOL", 26), false);
});

Deno.test("목표온도를 못 읽으면 걸지 않는다", () => {
  // attrs.target_temp가 없으면 Number(undefined) = NaN이다. NaN < 24는 거짓이지만,
  // 비교에 기대지 않고 Number.isFinite로 먼저 자른다.
  assertEquals(floorApplies("ON", "COOL", Number.NaN), false);
});
