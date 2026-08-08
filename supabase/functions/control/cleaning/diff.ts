/**
 * 스케줄 스냅샷과 그 비교 — 단일 책임: 순수 자료 변환. DB도 벤더도 건드리지 않는다.
 *
 * **변경 감지를 훅이 아니라 여기서 하는 이유**: 예약이 들어오는 경로가 넷이다(스클 파트너 API ·
 * Gmail Apps Script · 어드민 · `admin_set_time`). SQL 함수는 문자를 못 보내고, Apps Script에
 * 훅을 달면 SOLAPI 자격증명을 구글 인프라까지 복제해야 한다. 네 경로가 전부 `reservations`
 * 한 테이블로 모이므로, 테이블 쪽에서 한 번 보는 게 훅 네 개보다 안전하다.
 */

import { endTime, targetTime } from "../automation/windows.ts";
import { type CleaningReservation, isCarryOver } from "./windows.ts";

/** 문자 한 통이 '그때 말한' 스케줄의 한 줄. */
export interface SnapshotEntry {
  /** `reservations.id`. **diff의 유일한 키다** — 이름이나 시각으로 맞추면 연장과 신규를 못 가른다. */
  id: string;
  start: string; // 'HH:MM' (KST)
  end: string;
  /** 종료가 다음 날인가. `내일 02:00`처럼 적을지 가른다. */
  crossesMidnight: boolean;
  /** 어제에서 넘어온 예약인가. 목록에 `(어제)`를 붙인다. */
  carryOver: boolean;
  name: string;
  guests: number | null;
  purpose: string | null;
}

export interface ScheduleSnapshot {
  entries: SnapshotEntry[];
}

export interface ScheduleDiff {
  added: SnapshotEntry[];
  removed: SnapshotEntry[];
  changed: Array<{ before: SnapshotEntry; after: SnapshotEntry }>;
}

/** 예약 목록 → 스냅샷. 시작 시각 오름차순으로 담아 문구가 그대로 읽히게 한다. */
export function buildSnapshot(reservations: CleaningReservation[], now: Date): ScheduleSnapshot {
  const entries = reservations
    .map((r): SnapshotEntry => ({
      id: r.id,
      start: r.start_time.slice(0, 5),
      end: r.end_time.slice(0, 5),
      // `endTime`이 '종료가 시작보다 이르면 하루를 더한다'는 판정을 이미 갖고 있다.
      // 여기서 문자열을 다시 비교하면 그 규칙이 두 곳으로 갈라진다.
      crossesMidnight: endTime(r) > targetTime(r.date, r.end_time),
      carryOver: isCarryOver(r, now),
      name: r.name,
      guests: r.guests,
      purpose: r.purpose,
    }))
    .sort((a, b) => (a.carryOver === b.carryOver ? a.start.localeCompare(b.start) : a.carryOver ? -1 : 1));
  return { entries };
}

/**
 * 두 스냅샷을 비교한다.
 *
 * **시각이 바뀐 것만 `changed`로 본다.** 이름·인원·용도만 달라진 것은 청소 계획을 바꾸지
 * 않으므로 변경이 아니다 — 여기에 반응하면 연락처 백필 한 번에 문자가 나간다.
 *
 * 취소는 따로 다루지 않는다. `fetchRecent`가 `cancelled = false`만 가져와 취소된 예약은
 * 목록에서 사라지므로 `removed`로 자연히 떨어진다.
 */
export function compare(before: ScheduleSnapshot, after: ScheduleSnapshot): ScheduleDiff {
  const prev = new Map(before.entries.map((e) => [e.id, e] as const));
  const next = new Map(after.entries.map((e) => [e.id, e] as const));

  const diff: ScheduleDiff = { added: [], removed: [], changed: [] };
  for (const e of after.entries) {
    const old = prev.get(e.id);
    if (!old) diff.added.push(e);
    else if (old.start !== e.start || old.end !== e.end) diff.changed.push({ before: old, after: e });
  }
  for (const e of before.entries) {
    if (!next.has(e.id)) diff.removed.push(e);
  }
  return diff;
}

export function isEmpty(diff: ScheduleDiff): boolean {
  return !diff.added.length && !diff.removed.length && !diff.changed.length;
}

/**
 * 스냅샷의 지문. 겹친 두 틱이 같은 변경을 계산했을 때 하나만 통과시키는 열쇠다.
 *
 * **`id` 오름차순으로 정렬한 뒤 직렬화한다.** 정렬을 고정하지 않으면 같은 스케줄이 배열 순서만
 * 달라도 다른 지문이 되어 같은 변경이 두 번 나간다. 시각만 담는 것은 diff가 시각만 보기
 * 때문이다 — 이름이 바뀌었다고 지문이 달라지면 안 나갈 문자의 자리를 잡아버린다.
 */
export async function fingerprint(snapshot: ScheduleSnapshot): Promise<string> {
  const canonical = [...snapshot.entries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => `${e.id}:${e.start}-${e.end}`)
    .join("|");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
