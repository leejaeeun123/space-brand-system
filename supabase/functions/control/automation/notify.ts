/**
 * Mattermost 알림 — 단일 책임: 쌓인 이벤트를 사람이 읽을 한 건으로 묶어 보낸다.
 *
 * **묶는 것이 이 파일의 핵심 기능이다.** 입실 준비 한 번이 명령 8개(냉난방 3 + 조명 5)를 낳고,
 * 손님이 온도를 몇 번 누르면 그만큼 이벤트가 생긴다. 하나씩 보내면 채널을 못 쓰게 된다.
 * 틱이 이 함수를 부르므로 **알림은 분당 최대 (종류 수)건**으로 묶인다.
 *
 * 형식은 기존 예약 알림(`spacecloud-gmail-sync.gs`)과 같다 — `**제목** · 부제` + 마크다운 표.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as events from "./events.ts";
import type { EventKind, EventRow } from "./events.ts";

/** 종류별 제목. 실패가 섞이면 앞에 경고를 붙인다. */
const TITLE: Record<EventKind, string> = {
  prep: "자동 · 입실 준비",
  shutdown: "자동 · 퇴실 종료",
  sweep: "자동 · 퇴실 후 정리",
  temp_floor: "자동 · 온도 하한",
  remote_admin: "원격 조작 · 어드민",
  remote_guest: "원격 조작 · 손님",
  onsite: "현장 조작",
};

/**
 * 묶음의 대표 시각 — 그 종류의 **마지막** 이벤트. 발송 순서와 표시 시각이 같은 값을 써야
 * 채널이 앞뒤가 맞게 읽힌다. `fetchPending`이 오름차순이라 마지막이 가장 늦다.
 */
function groupTime(rows: EventRow[]): number {
  return Date.parse(rows[rows.length - 1].at);
}

/** 종류별 묶음을 일어난 순서대로. 채널이 앞뒤가 맞게 읽히는 유일한 근거라 따로 뺐다. */
export function orderGroups(
  byKind: Map<EventKind, EventRow[]>,
): Array<[EventKind, EventRow[]]> {
  return [...byKind.entries()].sort((a, b) => groupTime(a[1]) - groupTime(b[1]));
}

const ACTION_LABEL: Record<string, string> = {
  power_on: "켜기",
  power_off: "끄기",
  set_temp: "온도",
  set_mode: "모드",
  set_wind: "바람",
  observed: "변화",
};

const MODE_LABEL: Record<string, string> = {
  COOL: "냉방",
  HEAT: "난방",
  FAN: "송풍",
  AIR_DRY: "제습",
  AIR_CLEAN: "공기청정",
};

/**
 * 웹훅 주소. 기기 전용이 있으면 그쪽, 없으면 예약 알림과 같은 채널로 간다.
 *
 * 지금은 예약 알림과 같은 채널을 쓰기로 했다(형운 결정, 2026-08-07). 기기 알림이 훨씬 잦아
 * 예약 알림을 덮게 되면, **코드를 고치지 않고** `MATTERMOST_DEVICE_WEBHOOK_URL` 시크릿만
 * 넣어 분리할 수 있게 이 순서로 둔다.
 */
function webhookUrl(): string | null {
  return Deno.env.get("MATTERMOST_DEVICE_WEBHOOK_URL") ??
    Deno.env.get("MATTERMOST_WEBHOOK_URL") ?? null;
}

function deviceName(names: Map<string, string>, id: string): string {
  return names.get(id) ?? "알 수 없는 기기";
}

/** 한 줄의 오른쪽 칸 — 무엇을 했고 어떻게 됐는지. */
function outcome(e: EventRow): string {
  if (e.kind === "onsite") return e.value ?? "변화";

  const label = ACTION_LABEL[e.action] ?? e.action;
  let what = label;
  if (e.action === "set_temp" && e.value) what = `${e.value}도`;
  else if (e.action === "set_mode" && e.value) what = MODE_LABEL[e.value] ?? e.value;
  else if (e.action === "set_wind" && e.value) what = `바람 ${e.value}`;

  if (e.status === "failed") return `❌ ${what} — ${e.detail ?? "실패"}`;

  // 조명은 큐에 넣은 것까지가 우리가 아는 전부지만(`detail === "sent"`), **그걸 매번 적지는 않는다.**
  // 조명 명령엔 항상 붙어 있어서 정보가 되지 않고, 읽는 사람이 뜻을 다시 물어야 했다
  // (2026-08-08 형운 지적). 정말 안 된 경우는 따로 드러난다 — 스윕 창이 끝날 때까지
  // 안 꺼진 기기를 `enforce.ts`가 실패로 기록해 ⚠️로 띄운다. '항상 붙는 단서'보다
  // '안 됐을 때만 뜨는 경고'가 실제로 읽힌다.
  //
  // 장부에는 그대로 남긴다 — 화면에 안 보일 뿐 "큐에만 넣었다"는 사실 자체는 나중에
  // 원인을 추적할 때 필요하다.
  return what;
}

/** 같은 기기의 여러 줄을 한 줄로 — 손님이 +/-를 여러 번 눌러도 표가 길어지지 않는다. */
function mergeByDevice(rows: EventRow[]): Map<string, EventRow[]> {
  const byDevice = new Map<string, EventRow[]>();
  for (const e of rows) {
    const list = byDevice.get(e.device_id) ?? [];
    list.push(e);
    byDevice.set(e.device_id, list);
  }
  return byDevice;
}

export function buildMessage(
  kind: EventKind,
  rows: EventRow[],
  names: Map<string, string>,
): string {
  const failed = rows.some((e) => e.status === "failed");
  const title = failed ? `⚠️ ${TITLE[kind]} 실패 포함` : TITLE[kind];

  const lines = ["| 기기 | 내용 |", "|---|---|"];

  // 현장 조작은 **합치지 않는다.** set_temp 연타는 마지막이 최종 상태지만, 현장 조작은
  // 각각이 별개의 사람 행위다. 스위치를 네 번 만진 것을 한 줄로 뭉개면 1번으로 읽힌다.
  if (kind === "onsite") {
    for (const e of rows) {
      const t = new Date(e.at).toLocaleTimeString("ko-KR", {
        timeZone: "Asia/Seoul",
        hour12: false,
      });
      lines.push(`| ${deviceName(names, e.device_id)} | ${outcome(e)} (${t}) |`);
    }
    return `**${title}**\n\n${lines.join("\n")}`;
  }

  for (const [deviceId, list] of mergeByDevice(rows)) {
    // 같은 기기에 여러 명령이면 마지막 것이 최종 상태다(온도 26→24→22 는 22가 결과).
    // 다만 실패는 마지막이 아니어도 반드시 보여야 한다.
    const fails = list.filter((e) => e.status === "failed");
    const shown = fails.length ? fails : [list[list.length - 1]];
    lines.push(`| ${deviceName(names, deviceId)} | ${shown.map(outcome).join(" · ")} |`);
  }

  const at = rows[rows.length - 1]?.at;
  const when = at
    ? new Date(at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })
    : "";

  return `**${title}**${when ? ` · ${when}` : ""}\n\n${lines.join("\n")}`;
}

/**
 * 발송. **어떤 예외도 밖으로 던지지 않는다.**
 *
 * 알림이 실패했다고 기기 제어나 자동화가 망가지면 안 된다 — 기존 예약 알림
 * (`notifyMattermost`)과 같은 규칙이다.
 */
async function post(text: string): Promise<boolean> {
  const url = webhookUrl();
  if (!url) {
    console.warn("MATTERMOST_WEBHOOK_URL 미설정 — 알림을 건너뛴다");
    // **true를 돌려준다(=소진).** 설정 안 한 것은 '나중에 보낼 것'이 아니라 '안 보내기로 한 것'이다.
    // false로 두면 미발송 이벤트가 영원히 쌓이고(정리 크론은 발송된 것만 지운다) 테이블이 계속 큰다.
    return true;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`Mattermost 알림 실패 (${res.status})`, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("Mattermost 알림 예외", e);
    return false;
  }
}

/**
 * 아직 안 보낸 이벤트를 종류별로 묶어 보낸다.
 *
 * **선점 먼저, 발송 나중.** `automate`는 누구나 부를 수 있어 두 호출이 겹치면 같은 알림이
 * 두 번 갈 수 있는데, 선점이 그걸 막는다(`events.claimPending`). 발송에 실패한 종류만
 * 되돌려 다음 틱이 다시 시도한다.
 */
export async function flush(
  sb: SupabaseClient,
  names: Map<string, string>,
  now: Date,
): Promise<number> {
  const pending = await events.claimPending(sb, now);
  if (!pending.length) return 0;

  const byKind = new Map<EventKind, EventRow[]>();
  for (const e of pending) {
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }

  let sent = 0;
  const failed: number[] = [];

  // **일어난 순서대로 올린다.** 예전엔 종류별 고정 순서(중요도순)로 보냈는데, 채널은
  // 발송 순서가 곧 타임라인이라 그러면 시간이 거꾸로 보인다 — 손님이 조명을 켜고(00:59:41)
  // 스윕이 끈 것(01:00:01)이 위에 올라왔다(2026-08-08 형운 지적). 채널은 우선순위
  // 목록이 아니라 타임라인이다. 급한 것은 순서가 아니라 제목의 ⚠️가 드러낸다.
  //
  // 종류를 열거하지 않게 된 덕분에, 새 EventKind가 생겨도 목록 갱신을 빠뜨려 조용히
  // 안 나가는 일이 원천적으로 없어졌다.
  for (const [kind, rows] of orderGroups(byKind)) {
    if (await post(buildMessage(kind, rows, names))) sent += rows.length;
    else failed.push(...rows.map((r) => r.id));
  }

  await events.release(sb, failed);
  return sent;
}
