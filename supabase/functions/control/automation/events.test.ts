/**
 * `events.ts`의 순수 부분 — 정렬 계약만 본다.
 *
 * 이게 테스트할 값어치가 있는 이유: `message.ts`의 판단이 거의 전부 "입력이 시간순"이라는
 * 가정 위에 서 있는데, 그 가정을 만드는 곳이 `claimPending` 하나뿐이다. `update ... returning`의
 * 행 순서는 정의돼 있지 않아서 이 정렬이 빠지면 **에러 없이** 틀린 최종 상태가 채널에 찍힌다.
 *
 * 실행: `deno test supabase/functions/control/automation/events.test.ts`
 */

import { assertEquals } from "jsr:@std/assert@1";
import { sortByOccurrence } from "./events.ts";
import type { EventRow } from "./events.ts";

function row(id: number, at: string): EventRow {
  return {
    id,
    device_id: "ac",
    camera_id: null,
    at,
    kind: "remote_guest",
    action: "set_temp",
    value: String(id),
    status: "ok",
    detail: null,
  };
}

Deno.test("DB가 순서를 뒤섞어 줘도 일어난 순서로 되돌린다", () => {
  const shuffled = [
    row(3, "2026-08-10T10:02:00.000Z"),
    row(1, "2026-08-10T10:00:00.000Z"),
    row(2, "2026-08-10T10:01:00.000Z"),
  ];
  assertEquals(sortByOccurrence(shuffled).map((r) => r.id), [1, 2, 3]);
});

Deno.test("같은 시각이면 넣은 순서(id)로 — recordMany는 at이 전부 같다", () => {
  // `recordMany`는 한 statement라 넣은 행의 `at`이 동일하다(`now()`는 트랜잭션 시각).
  // `at`만으로 정렬하면 여기서 순서가 미정이 되고, "마지막이 최종 상태" 규칙이 무너진다.
  const same = "2026-08-10T10:00:00.000Z";
  const shuffled = [row(9, same), row(4, same), row(7, same)];
  assertEquals(sortByOccurrence(shuffled).map((r) => r.id), [4, 7, 9]);
});

Deno.test("원본 배열을 건드리지 않는다", () => {
  const rows = [row(2, "2026-08-10T10:01:00.000Z"), row(1, "2026-08-10T10:00:00.000Z")];
  sortByOccurrence(rows);
  assertEquals(rows.map((r) => r.id), [2, 1]);
});
