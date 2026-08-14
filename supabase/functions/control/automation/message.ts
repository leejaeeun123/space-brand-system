/**
 * 알림 메시지 조립 — 단일 책임: 쌓인 이벤트를 사람이 읽을 표 한 장으로 만든다.
 *
 * 발송(`notify.ts`)과 나눠 둔 이유는 여기가 **순수 함수만** 담기 때문이다. 네트워크도 DB도
 * 없어서 테스트가 웹훅이나 실기기 없이 전부 돈다(`message.test.ts`).
 *
 * **묶는 것이 핵심 기능이다.** 입실 준비 한 번이 명령 8개(냉난방 3 + 조명 5)를 낳고, 손님이
 * 온도를 몇 번 누르면 그만큼 이벤트가 생긴다. 하나씩 보내면 채널을 못 쓰게 된다.
 *
 * 형식은 기존 예약 알림(`spacecloud-gmail-sync.gs`)과 같다 — `**제목** · 부제` + 마크다운 표.
 */

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
  // 이건 status가 'ok'라(아무 명령도 실패하지 않았다) 제목이 스스로 경고를 달아야 한다.
  idle: "⚠️ 예약 없이 켜져 있음",
  // 아래 다섯도 idle과 같은 이유로 status는 항상 'ok'다 — '명령이 실패했다'가 아니라
  // '이런 상태를 관측했다'이므로, 경고는 title에 미리 박아둔다.
  device_offline: "⚠️ 기기 연결 끊김",
  device_recovered: "기기 연결 복구",
  camera_offline: "⚠️ CCTV 연결 끊김",
  camera_recovered: "CCTV 연결 복구",
  system_error: "⚠️ 자동화 시스템 오류",
};

/**
 * status와 무관하게 '관측 문장'을 그대로 보여주는 kind들.
 *
 * onsite·idle이 원래 이랬다 — value가 이미 완성된 문장이라 액션 라벨을 앞에 붙이면
 * 뜻이 겹친다("변화 — 전원 꺼짐 → 켜짐"). 연결 끊김/복구/시스템 오류도 같은 모양이라
 * 여기 합류시킨다.
 */
const OBSERVED_KINDS = new Set<EventKind>([
  "onsite",
  "idle",
  "device_offline",
  "device_recovered",
  "camera_offline",
  "camera_recovered",
  "system_error",
]);

const ACTION_LABEL: Record<string, string> = {
  power_on: "켜기",
  power_off: "끄기",
  set_temp: "온도",
  set_mode: "모드",
  set_wind: "바람",
};

const MODE_LABEL: Record<string, string> = {
  COOL: "냉방",
  HEAT: "난방",
  FAN: "송풍",
  AIR_DRY: "제습",
  AIR_CLEAN: "공기청정",
};

/**
 * 한 메시지의 문자 수 상한.
 *
 * Mattermost 기본 상한이 4000자다(`ServiceSettings.MaxPostSize`). 넘으면 거절당하고, 거절당한
 * 묶음은 되돌려져 다음 틱이 **같은 것을 다시 만든다** — 오래된 것부터 꺼내므로 그 묶음이 큐의
 * 머리에 눌러앉아 뒤의 알림까지 막는다.
 *
 * 건수 상한(`events.ts`의 PENDING_LIMIT 200)은 이걸 못 막는다. 현장 조작은 일부러 합치지
 * 않으므로 200건이 곧 200줄이고, 실패 줄에는 벤더 에러 원문이 붙어 한 줄이 길다.
 *
 * 그래서 **자르는 쪽**을 택한다. 다만 잘린 사실을 숨기지 않는다 — 조용히 사라진 알림은
 * 없는 알림보다 나쁘다.
 */
const MAX_CHARS = 3500;

/** 생략 줄이 들어갈 자리. 자를 때 이만큼은 비워둔다. */
const ELLIPSIS_RESERVE = 60;

const KST = { timeZone: "Asia/Seoul", hour12: false } as const;

/** '08:47' — 표 안에서는 짧아야 읽힌다. */
function hhmm(at: string): string {
  return new Date(at).toLocaleTimeString("ko-KR", { ...KST, hour: "2-digit", minute: "2-digit" });
}

/** '2026. 08. 10. 08:47' — 묶음 헤더용. */
function stamp(at: string): string {
  return new Date(at).toLocaleString("ko-KR", {
    ...KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 묶음의 대표 시각 — 그 종류의 **마지막** 이벤트. 발송 순서와 표시 시각이 같은 값을 써야
 * 채널이 앞뒤가 맞게 읽힌다.
 *
 * 입력이 시간순이라는 것은 `events.claimPending`이 보장한다 — 거기서 정렬을 확정하는 이유가
 * 바로 이 줄이다.
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

function deviceName(names: Map<string, string>, id: string | null): string {
  // null = 특정 기기가 아니라 공간 전체의 사건(전환 만료·전환 자체의 실패).
  if (id === null) return "공간 전체";
  return names.get(id) ?? "알 수 없는 기기";
}

/** 한 줄의 오른쪽 칸 — 무엇을 했고 어떻게 됐는지. */
function outcome(e: EventRow): string {
  // 관측된 사건은 value가 그대로 문장이다. 액션 라벨을 앞에 붙이면 '변화 — 전원 꺼짐 → 켜짐'
  // 처럼 같은 말이 두 번 나온다.
  if (OBSERVED_KINDS.has(e.kind)) return e.value ?? "변화";

  // 공간 전체 사건은 detail이 전부다 — 보내지도 못한 명령의 '켜기/끄기'를 적으면
  // 마치 시도는 했다는 것처럼 읽힌다. camera_id도 없어야 진짜 '공간 전체'다 — 카메라 사건은
  // device_id가 항상 null이지만(카메라는 devices 테이블에 없다) 특정 카메라를 가리킨다.
  //
  // ❌는 **status를 보고** 붙인다. 여기 오는 것이 전부 실패였을 땐 무조건 붙여도 같았지만,
  // 이제 '일부러 안 했다'(다음 예약 인계로 퇴실 종료를 건너뜀)가 같은 모양으로 들어온다.
  // 정상 판단에 ❌를 달면 사람이 ❌를 무시하는 법을 배운다 — 그 순간 진짜 실패도 같이 묻힌다.
  if (e.device_id === null && e.camera_id === null) {
    if (e.status === "failed") return `❌ ${e.detail ?? "실행하지 못했습니다"}`;
    return e.detail ?? "건너뜀";
  }

  const label = ACTION_LABEL[e.action] ?? e.action;
  let what = label;
  if (e.action === "set_temp" && e.value) what = `${e.value}도`;
  else if (e.action === "set_mode" && e.value) what = MODE_LABEL[e.value] ?? e.value;
  else if (e.action === "set_wind" && e.value) what = `바람 ${e.value}`;

  if (e.status === "failed") return `❌ ${what} — ${e.detail ?? "실패"}`;

  // 조명은 큐에 넣은 것까지가 우리가 아는 전부지만(`detail === "sent"`), **그걸 매번 적지는
  // 않는다.** 조명 명령엔 항상 붙어 있어서 정보가 되지 않고, 읽는 사람이 뜻을 다시 물어야 했다
  // (2026-08-08 형운 지적). 정말 안 된 경우는 따로 드러난다 — 스윕 창이 끝날 때까지 안 꺼진
  // 기기를 `enforce.ts`가 실패로 기록해 ⚠️로 띄운다. '항상 붙는 단서'보다 '안 됐을 때만 뜨는
  // 경고'가 실제로 읽힌다.
  //
  // 장부에는 그대로 남긴다 — 화면에 안 보일 뿐, 나중에 원인을 추적할 땐 필요하다.
  return what;
}

/**
 * 같은 기기(또는 카메라)의 여러 줄을 한 줄로 — 손님이 +/-를 여러 번 눌러도 표가 길어지지 않는다.
 *
 * 그룹 키는 `device_id ?? camera_id` — 한 행에 최대 하나만 채워지므로(마이그레이션의
 * `device_events_target_check`) 충돌하지 않는다. 둘 다 null(공간 전체)인 행끼리는 여전히
 * 한 그룹으로 묶이는데, `system_error`처럼 서로 다른 서브시스템의 실패가 같은 틱에 섞이면
 * 이 묶음이 마지막 한 건만 남기고 나머지를 지운다 — 그래서 `buildMessage`가 `system_error`는
 * 아예 이 함수를 거치지 않고 `onsite`처럼 줄마다 따로 보여준다.
 */
function mergeByDevice(rows: EventRow[]): Map<string | null, EventRow[]> {
  const byDevice = new Map<string | null, EventRow[]>();
  for (const e of rows) {
    const key = e.device_id ?? e.camera_id ?? null;
    const list = byDevice.get(key) ?? [];
    list.push(e);
    byDevice.set(key, list);
  }
  return byDevice;
}

/**
 * 관측된 사건이 **언제 일어났는지는 모른다 — 언제 알아챘는지만 안다.**
 *
 * 빈 시간엔 냉난방 상태를 10분에 한 번만 물어보므로(`handlers/automation.ts`), 이벤트의 `at`은
 * 실제 조작보다 한참 뒤일 수 있다. 그걸 시각 하나로 찍으면 사람이 자기 행동과 대조하다 틀린다.
 *
 * 2026-08-08에 실제로 그랬다 — '전원 꺼짐 → 켜짐 (08:47)'이 방향이 뒤집힌 것 아니냐는 의심을
 * 받았다. 그 시간대에 현장 직원이 있었으니 표시가 맞았을 가능성이 크다(확정은 아니다).
 * 08:47은 우리가 알아챈 시각이었을 뿐인데 그게 조작 시각처럼 보인 것이다 — 맞는 값을
 * 틀리게 읽히도록 찍는 것도 결함이다.
 *
 * `observe.ts`가 기준선을 뜬 시각을 `detail`에 남겨두므로, 있으면 구간으로 적는다.
 */
function observedWhen(e: EventRow): string {
  return e.detail ? `${hhmm(e.detail)}~${hhmm(e.at)} 사이` : hhmm(e.at);
}

/**
 * 상한을 넘으면 줄을 줄인다.
 *
 * 자를 땐 **실패 줄을 먼저 남긴다** — 잘려도 되는 건 잘 된 줄이지 안 된 줄이 아니다.
 * (`sort`는 안정 정렬이라 같은 등급 안에서는 원래 순서가 유지된다.)
 */
function fit(lines: string[], overhead: number): string[] {
  const size = (ls: string[]) => overhead + ls.reduce((n, l) => n + l.length + 1, 0);
  if (size(lines) <= MAX_CHARS) return lines;

  const ordered = [...lines].sort((a, b) => Number(b.includes("❌")) - Number(a.includes("❌")));
  const kept: string[] = [];
  for (const line of ordered) {
    if (size([...kept, line]) + ELLIPSIS_RESERVE > MAX_CHARS) break;
    kept.push(line);
  }
  return [...kept, `| … | 외 ${lines.length - kept.length}건 생략 (길이 상한) |`];
}

export function buildMessage(
  kind: EventKind,
  rows: EventRow[],
  names: Map<string, string>,
): string {
  const failed = rows.some((e) => e.status === "failed");
  const title = failed ? `⚠️ ${TITLE[kind]} 실패 포함` : TITLE[kind];

  const head = ["| 기기 | 내용 |", "|---|---|"];

  // 관측된 사건은 **합치지 않는다.** set_temp 연타는 마지막이 최종 상태지만, 현장 조작은
  // 각각이 별개의 사람 행위다. 스위치를 네 번 만진 것을 한 줄로 뭉개면 1번으로 읽힌다.
  if (kind === "onsite") {
    const lines = rows.map((e) =>
      `| ${deviceName(names, e.device_id)} | ${outcome(e)} (${observedWhen(e)}) |`
    );
    return `**${title}**\n\n${[...head, ...fit(lines, title.length + 40)].join("\n")}`;
  }

  // system_error는 device_id/camera_id가 항상 null이라 mergeByDevice에 그대로 넘기면 같은 틱에
  // 섞인 서로 다른 서브시스템 실패(예: 문자 스윕 + 알림 발송)가 한 줄로 뭉개져 마지막 것만
  // 남는다. onsite와 같은 이유로 합치지 않는다 — 다만 시각은 `hhmm`만 쓴다. onsite는 알아챈
  // 시각과 실제 조작 시각이 다를 수 있어 구간(`observedWhen`)이 필요했지만, system_error의
  // `at`은 예외가 실제로 발생한 그 순간이라 구간을 쓸 이유가 없다.
  if (kind === "system_error") {
    const lines = rows.map((e) => `| 공간 전체 | ${outcome(e)} (${hhmm(e.at)}) |`);
    return `**${title}**\n\n${[...head, ...fit(lines, title.length + 40)].join("\n")}`;
  }

  const lines: string[] = [];
  for (const [deviceId, list] of mergeByDevice(rows)) {
    // 같은 기기에 여러 명령이면 마지막 것이 최종 상태다(온도 26→24→22 는 22가 결과).
    // 다만 실패는 마지막이 아니어도 반드시 보여야 한다.
    const fails = list.filter((e) => e.status === "failed");
    const shown = fails.length ? fails : [list[list.length - 1]];
    lines.push(`| ${deviceName(names, deviceId)} | ${shown.map(outcome).join(" · ")} |`);
  }

  const at = rows[rows.length - 1]?.at;
  const when = at ? ` · ${stamp(at)}` : "";
  return `**${title}**${when}\n\n${[...head, ...fit(lines, title.length + when.length + 40)].join("\n")}`;
}
