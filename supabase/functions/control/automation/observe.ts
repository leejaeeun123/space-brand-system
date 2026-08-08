/**
 * 현장 조작 판별 — 단일 책임: 관측된 상태 변화 중 **우리가 설명할 수 없는 것**을 골라낸다.
 *
 * 벽 스위치와 에어컨 리모컨은 우리 API를 거치지 않아 직접 볼 방법이 없다. 그래서 이렇게 뺀다:
 *
 *     관측된 상태 변화  −  최근 우리가 보낸 명령  =  현장 조작
 *
 * 즉 이 판정은 관측이 아니라 **추론이고 잔여 범주**다. 장부가 비거나 늦으면 우리가 켠 것을
 * "현장에서 누가 켰다"고 알리게 된다 — 이 파일에서 가장 조심할 곳은 대조 창이다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { list } from "../handlers/list.ts";
import * as events from "./events.ts";
import { fetchWatch, saveObservation, type Watch } from "./store.ts";
import { STALE_AFTER_SECONDS } from "../types.ts";

type DeviceList = Awaited<ReturnType<typeof list>>["devices"];

/**
 * 대조 창의 **하한**. 실제 창은 기기마다 "마지막으로 기준선을 뜬 시각(`seen_at`) 이후"이고,
 * 이 값은 그 창이 그보다 짧아지지 않게 막는 바닥이다.
 *
 * **고정 창을 버린 것이 이 파일에서 가장 중요한 수정이다.** 예약이 없는 시간엔 ThinQ 상태를
 * 10분에 한 번만 물어보는데(`handlers/automation.ts`의 IDLE_THINQ_MAX_AGE_SECONDS = 600),
 * 창은 120초 고정이었다. 관측 지연이 창보다 5배 길면 **우리가 보낸 명령은 항상 창 밖으로
 * 나간다** — 빈 시간에 사람이 원격으로 누른 것은 몇 분 뒤 '현장 조작'으로 뜨게 된다.
 *
 * (이건 상수 둘을 대조해 도출한 것이지 그런 알림을 실제로 본 것은 아니다. 2026-08-08에 오탐이
 * 의심된 건이 하나 있었는데 그건 확인 결과 **표시가 맞았다** — 시각 표기 문제였고
 * 그쪽은 `message.ts`의 관측 구간 표기로 따로 고쳤다.)
 *
 * 지금 감지한 변화는 정의상 기준선을 뜬 뒤에 일어났다. 그러니 그 구간의 명령이면 무엇이든
 * 이 변화를 설명할 수 있고, 그 구간 밖의 명령은 설명할 수 없다 — 창을 관측 주기가 정하게
 * 두면 주기를 바꿔도 여기를 같이 고칠 필요가 없다.
 *
 * 바닥을 남기는 이유: 명령 직후의 상태 읽기가 벤더 반영보다 빠를 수 있어(조명은 큐 TTL 60초,
 * ThinQ도 control 직후 재조회가 옛 값을 주는 일이 있다) 명령이 기준선보다 조금 앞선 시각에
 * 찍힐 수 있다. 그만큼 뒤로 더 본다.
 */
const CORRELATION_FLOOR_MS = 120_000;

/**
 * 이보다 긴 관측 공백은 '주기'가 아니라 '단절'로 본다.
 *
 * 가장 느린 정상 관측이 유휴 시간의 ThinQ 폴링(600초 = `STALE_AFTER_SECONDS`)이라 그
 * 두 배로 잡는다 — 정상 주기로는 절대 안 걸리고, 진짜 단절은 걸린다(2026-08-08 아침
 * 바닥 조명 두 대는 몇 시간이었다).
 */
const CONTACT_GAP_MS = 2 * STALE_AFTER_SECONDS * 1000;

/**
 * 기준선이 된 판독값과 이번 판독값 사이가 '못 본 구간'인가.
 *
 * 순수 함수로 빼 둔 이유는 이게 현장 조작 판정을 통째로 삼키는 문이기 때문이다 —
 * DB 없이 검증된다(`observe.test.ts`).
 */
export function isContactGap(baselineAt: Date, readingAt: Date): boolean {
  return readingAt.getTime() - baselineAt.getTime() > CONTACT_GAP_MS;
}

/** 명령 → 그 명령이 건드리는 축. `handlers/command.ts`의 AXIS와 같은 구분이다. */
const AXIS: Record<string, string> = {
  power_on: "power",
  power_off: "power",
  set_temp: "temp",
  set_mode: "mode",
  set_wind: "wind",
};

function tempOf(d: DeviceList[number]): number | null {
  const raw = (d.state?.attrs as Record<string, unknown> | undefined)?.target_temp;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 사람이 읽을 변화 설명. '꺼짐 → 켜짐', '26 → 22도'. */
function describe(before: string, after: string): string {
  return `${before} → ${after}`;
}

function powerLabel(p: string | null): string {
  if (p === "ON") return "켜짐";
  if (p === "OFF") return "꺼짐";
  return "모름";
}

/**
 * 지금 상태를 기준선과 비교해 현장 조작을 기록하고, 기준선을 갱신한다.
 *
 * 처음 보는 기기는 변화로 치지 않는다 — 기준선이 없을 뿐인데 알리면 배포 직후 모든 기기가
 * "현장에서 조작됐다"고 나간다.
 */
export async function detectOnsite(
  sb: SupabaseClient,
  devices: DeviceList,
  now: Date,
): Promise<number> {
  let watching: Map<string, Watch>;
  try {
    watching = await fetchWatch(sb);
  } catch (e) {
    console.error("기기 감시 조회 실패 — 이번 틱의 현장 조작 판별을 건너뛴다", e);
    return 0;
  }

  // 기기마다 창의 시작이 다르다(그 기기의 기준선을 뜬 시각). 조회는 그중 가장 이른 시각으로
  // 한 번만 하고, 대조는 기기별 시작으로 다시 좁힌다 — 한 기기의 오래된 기준선이 다른 기기의
  // 창까지 넓혀 남의 명령이 이 변화를 설명해버리면 안 된다.
  const floor = new Date(now.getTime() - CORRELATION_FLOOR_MS);
  const since = (deviceId: string): Date => {
    const seen = watching.get(deviceId)?.seenAt;
    return seen && seen < floor ? seen : floor;
  };
  const earliest = devices.reduce<Date>((min, d) => (since(d.id) < min ? since(d.id) : min), floor);

  const recent = await events.fetchRecentCommands(sb, earliest);

  // **축까지 좁힌다.** 기기 단위로 두면 우리가 set_temp를 보낸 직후 손님이 리모컨으로 전원을
  // 꺼도 "설명됨"으로 삼켜지고, 기준선까지 갱신돼 그 사건은 영영 안 잡힌다. 우리가 온도를
  // 만졌다는 사실이 전원 변화를 설명하지는 않는다.
  const explains = (deviceId: string, axis: string): boolean => {
    const from = since(deviceId).getTime();
    return recent.some((e) =>
      e.device_id === deviceId && (AXIS[e.action] ?? e.action) === axis &&
      Date.parse(e.at) >= from
    );
  };

  const found: events.EventInput[] = [];

  for (const d of devices) {
    const power = d.state?.power ?? null;
    const temp = tempOf(d);
    const prev = watching.get(d.id);

    // **이 판독값은 언제 것인가.** 틱 시각이 아니라 벤더가 그 값을 준 시각이다 — 빈 시간엔
    // 바뀌지 않은 캐시를 여러 틱 연속으로 읽으므로 둘은 10분까지 벌어진다.
    const readAt = d.state?.updated_at ? new Date(d.state.updated_at) : now;

    // 상태를 한 번도 받은 적 없는 기기는 비교 자체가 무의미하다('모름'끼리 비교하게 된다).
    const known = d.state?.never_seen === false;

    // **끊겼다 돌아온 기기는 변화로 치지 않는다.** 기준선과 이 판독값 사이가 관측 주기로
    // 설명 안 되는 공백이면, 그 사이의 변화는 '사람이 만졌다'가 아니라 **'우리가 못 봤다'**이다.
    // `null`을 조작으로 안 치는 것과 같은 이유다.
    //
    // 2026-08-08 11:34 실측: 바닥 조명 두 대가 전원 문제로 몇 시간 끊겼다 돌아오면서 자기
    // 상태(ON)를 보고했고, 기준선(OFF)과 달라 **둘 다 '현장 조작'으로 떴다.** 아무도 안
    // 만졌는데 만졌다고 알린 것이다.
    const gap = prev?.seenAt && isContactGap(prev.seenAt, readAt);
    if (gap) console.warn("관측 공백 — 변화를 조작으로 치지 않고 기준선만 갱신한다", d.id);

    if (prev?.seenAt && known && !gap) {
      const changes: string[] = [];
      // `null`('모름')이 끼는 전이는 현장 조작이 아니다 — 사람이 만진 게 아니라 **우리가 못 본
      // 것**이다. ThinQ가 200을 주면서 payload만 이상해도 power가 null이 되는데, 그걸 조작으로
      // 알리면 이용 중 손님이 아무것도 안 했는데 '켜짐 → 모름', 다음 틱에 '모름 → 켜짐'으로
      // 두 건이 나간다. 알림을 믿을 수 없게 만드는 종류의 오탐이다.
      if (
        prev.lastPower !== power && prev.lastPower !== null && power !== null &&
        !explains(d.id, "power")
      ) {
        changes.push(`전원 ${describe(powerLabel(prev.lastPower), powerLabel(power))}`);
      }
      // 온도는 냉난방만. 조명은 애초에 이 축이 없다.
      if (
        d.kind === "hvac" && prev.lastTemp !== temp && temp !== null && prev.lastTemp !== null &&
        !explains(d.id, "temp")
      ) {
        changes.push(`온도 ${describe(`${prev.lastTemp}도`, `${temp}도`)}`);
      }

      // 설명되지 않고 남은 변화만 현장 조작이다(축별 대조는 위에서 이미 끝났다).
      if (changes.length) {
        found.push({
          device_id: d.id,
          kind: "onsite",
          action: "observed",
          value: changes.join(" · "),
          status: "ok",
          // **언제 일어났는지는 모른다 — 언제 알아챘는지만 안다.** 빈 시간엔 관측이 10분에
          // 한 번이라 실제 조작보다 한참 뒤일 수 있다. 채널에서 그게 "방금 일어난 일"로
          // 읽히면 사람이 자기 행동과 대조하다 틀린다 — 2026-08-08의 '꺼짐 → 켜짐 (08:47)'이
          // 방향이 뒤집힌 것 아니냐는 의심을 받았다. 표시는 맞았고(사람이 현장에서 직접 켰다),
          // 08:47이 조작 시각이 아니라 관측 시각이었던 게 원인이다.
          // 기준선 판독값의 시각을 함께 남겨 표에 '08:37~08:47 사이'로 찍는다.
          detail: prev.seenAt.toISOString(),
        });
      }
    }

    // **틱 시각이 아니라 판독값의 시각을 기록한다.** 이게 대조 창의 시작점이며, 틱 시각을
    // 쓰면 창이 항상 1분짜리로 좁아져 고정 120초와 똑같아진다(2026-08-08 배포 직후 실측 —
    // `seen_at`이 6대 전부 직전 틱 시각이었고, 그래서 이 수정 전까지는 사실상 무용지물이었다).
    await saveObservation(sb, d.id, power, temp, readAt);
  }

  await events.recordMany(sb, found);
  return found.length;
}
