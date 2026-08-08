/**
 * 청소 담당자에게 나가는 문구 — **이 파일이 정본이다.**
 *
 * 손님 문구(`sms/templates.ts`)와 파일을 나눈 이유: 수신자도 톤도 담는 정보도 다르다.
 * 한 파일에 두면 손님 문구를 고치다 담당자 문구가 같이 움직인다.
 *
 * 담당자는 **내부 인력**이라(형운 확인, 2026-08-09) 예약자 이름·인원·용도를 싣는다.
 * 「개인정보 보호법」 §26 처리위탁이 아니라 §28 취급자다. **외주로 바꾸면 이 판단을 다시 본다.**
 * 연락처는 담지 않는다 — 청소에 쓸 일이 없고, 안 실으면 안 새는 값이다.
 *
 * 네트워크도 DB도 없는 순수 함수만 둔다. 그래서 문구 검증이 발송 없이 전부 돈다.
 */

import { kstDay, targetTime } from "../automation/windows.ts";
import type { ScheduleDiff, SnapshotEntry } from "./diff.ts";
import { type CleaningPlan, type CleaningWindow, isNextDay, type TightGap } from "./windows.ts";

const KST_SHIFT_MS = 9 * 60 * 60 * 1000;
const BRAND = "[타입라운지]";

/** KST 벽시계 'HH:MM'. **`toLocaleTimeString`을 쓰지 않는다** — 로케일에 따라 24:00이 나온다. */
function hhmm(at: Date): string {
  return new Date(at.getTime() + KST_SHIFT_MS).toISOString().slice(11, 16);
}

/** '2026-08-09' → '8/9(토)'. 요일은 정오 기준으로 뽑아 경계에서 흔들리지 않게 한다. */
function dayLabel(now: Date): string {
  const day = kstDay(now);
  const weekday = targetTime(day, "12:00:00")
    .toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}(${weekday})`;
}

/** 분 → 사람이 읽는 길이. 480분보다 8시간이 낫다. */
function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}분`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/** 예약 한 줄. 값이 없는 조각은 통째로 뺀다 — 빈칸을 지어내지 않는다. */
function entryLine(e: SnapshotEntry): string {
  const parts = [`${e.start}–${e.end}`, e.name];
  if (e.guests !== null) parts.push(`${e.guests}명`);
  const head = (e.carryOver ? "(어제) " : "") + parts.join(" ");
  return e.purpose ? `${head} · ${e.purpose}` : head;
}

function windowLine(w: CleaningWindow, now: Date): string {
  if (w.from === null) return "오늘 언제든";
  if (w.to === null) {
    // 마지막 퇴실 이후. 자정을 넘겼으면 '02:00 이후'가 오늘 새벽으로 읽히므로 못을 박는다.
    return `${isNextDay(w.from, now) ? "내일 " : ""}${hhmm(w.from)} 이후`;
  }
  // 진행 중인 창은 `remaining`이 시작을 '지금'으로 이미 당겨놨다 — 여기서 더 할 일이 없다.
  return `${hhmm(w.from)}–${hhmm(w.to)} (${duration(w.minutes ?? 0)})`;
}

/**
 * 연달림 경고. **조사를 피해 '사이는'으로 적는다** — 앞 글자에 받침이 있는지에 따라
 * 은/는이 갈리는데, 시각 문자열은 그때그때 다르다.
 */
function tightLine(g: TightGap): string {
  const span = `${hhmm(g.afterEnd)}→${hhmm(g.beforeStart)}`;
  return g.minutes === 0
    ? `⚠️ ${span} 사이는 붙어 있어 청소 시간이 없어요`
    : `⚠️ ${span} 사이는 ${g.minutes}분이라 청소 시간이 없어요`;
}

function cleaningBlock(plan: CleaningPlan, now: Date, title: string): string[] {
  const lines = [title, ...plan.windows.map((w) => windowLine(w, now))];
  if (plan.tight.length) lines.push("", ...plan.tight.map(tightLine));
  return lines;
}

/**
 * 아침 다이제스트. **예약이 0건이어도 보낸다** — 침묵은 '예약 없음'과 'cron이 죽음'을
 * 구분해주지 않는다. 이 레포가 조용한 실패를 사고로 보는 것과 같은 판단이다.
 */
export function digestMessage(
  entries: SnapshotEntry[],
  plan: CleaningPlan,
  now: Date,
): string {
  const head = `${BRAND} ${dayLabel(now)} 청소 안내`;
  if (entries.length === 0) {
    return [head, "", "오늘 예약이 없어요. 청소는 편한 시간에 하시면 됩니다."].join("\n");
  }
  return [
    head,
    "",
    `■ 오늘 예약 ${entries.length}건`,
    ...entries.map(entryLine),
    "",
    ...cleaningBlock(plan, now, "■ 청소 가능"),
  ].join("\n");
}

/**
 * 변경 안내.
 *
 * **청소 창을 다시 싣는다.** 담당자가 실제로 행동하는 값이 그것이라, "예약이 하나 늘었어요"만
 * 보내면 담당자가 머릿속으로 다시 계산해야 한다.
 */
export function updateMessage(diff: ScheduleDiff, plan: CleaningPlan, now: Date): string {
  const changes = [
    ...diff.added.map((e) => `+ 추가  ${entryLine(e)}`),
    ...diff.removed.map((e) => `− 취소  ${e.start}–${e.end} ${e.name}`),
    ...diff.changed.map(({ before, after }) =>
      `↻ 변경  ${before.start}–${before.end} → ${after.start}–${after.end} ${after.name}`
    ),
  ];
  return [
    `${BRAND} ${dayLabel(now)} 예약 변경`,
    "",
    ...changes,
    "",
    ...cleaningBlock(plan, now, "■ 청소 가능 (변경 후)"),
  ].join("\n");
}
