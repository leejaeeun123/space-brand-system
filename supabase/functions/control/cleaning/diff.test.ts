/**
 * 스냅샷 비교 테스트 — 변경 감지가 훅이 아니라 여기에 있으므로, 여기가 곧 감지기다.
 *
 * 두 가지를 특히 못 박는다: **이름·인원·용도만 바뀐 것은 변경이 아니다**(연락처 백필 한 번에
 * 문자가 나가면 안 된다), 그리고 **지문이 배열 순서에 흔들리지 않는다**(흔들리면 같은 변경이
 * 두 번 나간다).
 *
 * 실행: `deno test supabase/functions/control/cleaning/diff.test.ts`
 */

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { buildSnapshot, compare, fingerprint, isEmpty } from "./diff.ts";
import type { CleaningReservation } from "./windows.ts";

const DAY = "2026-08-09";

function res(
  id: string,
  start: string,
  end: string,
  over: Partial<CleaningReservation> = {},
): CleaningReservation {
  return {
    id,
    date: DAY,
    start_time: `${start}:00`,
    end_time: `${end}:00`,
    name: "김민수",
    guests: 6,
    purpose: null,
    ...over,
  };
}

function kst(hhmm: string, date = DAY): Date {
  return new Date(`${date}T${hhmm}:00+09:00`);
}

const NOW = kst("07:00");

Deno.test("스냅샷은 시작 시각 순으로, 넘어온 예약을 맨 앞에 둔다", () => {
  const snap = buildSnapshot([
    res("b", "13:00", "17:00"),
    res("a", "09:00", "12:00"),
    res("y", "22:00", "02:00", { date: "2026-08-08" }),
  ], NOW);
  assertEquals(snap.entries.map((e) => e.id), ["y", "a", "b"]);
  assertEquals(snap.entries[0].carryOver, true);
  assertEquals(snap.entries[1].carryOver, false);
});

Deno.test("자정을 넘기는 예약에 표시가 붙는다", () => {
  const snap = buildSnapshot([res("a", "22:00", "02:00"), res("b", "09:00", "12:00")], NOW);
  const byId = new Map(snap.entries.map((e) => [e.id, e] as const));
  assertEquals(byId.get("a")!.crossesMidnight, true);
  assertEquals(byId.get("b")!.crossesMidnight, false);
});

Deno.test("추가 · 취소 · 시간변경을 각각 잡는다", () => {
  const before = buildSnapshot([res("a", "09:00", "12:00"), res("b", "13:00", "17:00")], NOW);
  const after = buildSnapshot([res("b", "13:00", "19:00"), res("c", "20:00", "22:00")], NOW);
  const diff = compare(before, after);

  assertEquals(diff.added.map((e) => e.id), ["c"]);
  // 취소는 따로 다루지 않는다 — fetchRecent가 cancelled=false만 주므로 목록에서 사라진다
  assertEquals(diff.removed.map((e) => e.id), ["a"]);
  assertEquals(diff.changed.map((c) => [c.before.end, c.after.end]), [["17:00", "19:00"]]);
  assertEquals(isEmpty(diff), false);
});

Deno.test("이름·인원·용도만 바뀐 것은 변경이 아니다", () => {
  // 연락처 백필이나 어드민 오타 수정에 반응하면 담당자 폰이 이유 없이 울린다.
  const before = buildSnapshot([res("a", "09:00", "12:00", { name: "김민수", guests: 6 })], NOW);
  const after = buildSnapshot([
    res("a", "09:00", "12:00", { name: "김민수(연락처 확인)", guests: 8, purpose: "회의" }),
  ], NOW);
  assertEquals(isEmpty(compare(before, after)), true);
});

Deno.test("변경 없음이면 빈 diff다", () => {
  const snap = buildSnapshot([res("a", "09:00", "12:00")], NOW);
  assertEquals(isEmpty(compare(snap, snap)), true);
  assertEquals(isEmpty(compare(buildSnapshot([], NOW), buildSnapshot([], NOW))), true);
});

Deno.test("id가 키다 — 시각이 같아도 다른 예약이면 추가+취소로 잡힌다", () => {
  const before = buildSnapshot([res("a", "09:00", "12:00")], NOW);
  const after = buildSnapshot([res("z", "09:00", "12:00")], NOW);
  const diff = compare(before, after);
  assertEquals(diff.added.map((e) => e.id), ["z"]);
  assertEquals(diff.removed.map((e) => e.id), ["a"]);
  assertEquals(diff.changed, []);
});

Deno.test("지문은 배열 순서에 흔들리지 않는다", async () => {
  const one = buildSnapshot([res("a", "09:00", "12:00"), res("b", "13:00", "17:00")], NOW);
  const two = buildSnapshot([res("b", "13:00", "17:00"), res("a", "09:00", "12:00")], NOW);
  assertEquals(await fingerprint(one), await fingerprint(two));
});

Deno.test("지문은 시각이 바뀌면 달라지고, 이름만 바뀌면 그대로다", async () => {
  const base = buildSnapshot([res("a", "09:00", "12:00")], NOW);
  const timeChanged = buildSnapshot([res("a", "09:00", "13:00")], NOW);
  const nameChanged = buildSnapshot([res("a", "09:00", "12:00", { name: "다른 이름" })], NOW);

  assertNotEquals(await fingerprint(base), await fingerprint(timeChanged));
  // 이름이 바뀌었다고 지문이 달라지면, 나가지도 않을 문자가 유니크 인덱스의 자리를 잡는다
  assertEquals(await fingerprint(base), await fingerprint(nameChanged));
});

Deno.test("빈 스냅샷도 지문이 나온다", async () => {
  const empty = await fingerprint({ entries: [] });
  assertEquals(empty.length, 64); // SHA-256 hex
  assertNotEquals(empty, await fingerprint(buildSnapshot([res("a", "09:00", "12:00")], NOW)));
});
