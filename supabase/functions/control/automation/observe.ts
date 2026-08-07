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

type DeviceList = Awaited<ReturnType<typeof list>>["devices"];

/**
 * 우리 명령이 상태에 반영되기까지 기다려주는 시간.
 *
 * 조명은 큐에 들어가고(최대 60초 TTL) → 현장 맥 에이전트가 발행하고 → 기기가 stat으로 보고해야
 * 상태가 바뀐다. 창을 짧게 잡으면 **우리가 켠 조명을 현장 조작으로 오인한다.** 냉난방은 HTTP
 * 동기라 훨씬 짧아도 되지만, 규칙이 하나인 편이 낫다.
 *
 * 대가는 반대편이다 — 우리 명령 직후 이 시간 안에 일어난 진짜 현장 조작은 우리 것으로 흡수돼
 * 알리지 않는다. 드물고, 없는 일을 알리는 것보다 낫다.
 */
const CORRELATION_WINDOW_MS = 120_000;

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
): Promise<{ onsite: number; previous: Map<string, Watch> }> {
  let watching: Map<string, Watch>;
  try {
    watching = await fetchWatch(sb);
  } catch (e) {
    console.error("기기 감시 조회 실패 — 이번 틱의 현장 조작 판별을 건너뛴다", e);
    return { onsite: 0, previous: new Map() };
  }

  const recent = await events.fetchRecentCommands(
    sb,
    new Date(now.getTime() - CORRELATION_WINDOW_MS),
  );
  // **축까지 좁힌다.** 기기 단위로 두면 우리가 set_temp를 보낸 직후 손님이 리모컨으로 전원을
  // 꺼도 "설명됨"으로 삼켜지고, 기준선까지 갱신돼 그 사건은 영영 안 잡힌다. 우리가 온도를
  // 만졌다는 사실이 전원 변화를 설명하지는 않는다.
  const commanded = new Set(recent.map((e) => `${e.device_id}:${AXIS[e.action] ?? e.action}`));

  const found: events.EventInput[] = [];

  for (const d of devices) {
    const power = d.state?.power ?? null;
    const temp = tempOf(d);
    const prev = watching.get(d.id);

    // 상태를 한 번도 받은 적 없는 기기는 비교 자체가 무의미하다('모름'끼리 비교하게 된다).
    const known = d.state?.never_seen === false;

    if (prev?.seenAt && known) {
      const changes: string[] = [];
      // `null`('모름')이 끼는 전이는 현장 조작이 아니다 — 사람이 만진 게 아니라 **우리가 못 본
      // 것**이다. ThinQ가 200을 주면서 payload만 이상해도 power가 null이 되는데, 그걸 조작으로
      // 알리면 이용 중 손님이 아무것도 안 했는데 '켜짐 → 모름', 다음 틱에 '모름 → 켜짐'으로
      // 두 건이 나간다. 알림을 믿을 수 없게 만드는 종류의 오탐이다.
      if (
        prev.lastPower !== power && prev.lastPower !== null && power !== null &&
        !commanded.has(`${d.id}:power`)
      ) {
        changes.push(`전원 ${describe(powerLabel(prev.lastPower), powerLabel(power))}`);
      }
      // 온도는 냉난방만. 조명은 애초에 이 축이 없다.
      if (
        d.kind === "hvac" && prev.lastTemp !== temp && temp !== null && prev.lastTemp !== null &&
        !commanded.has(`${d.id}:temp`)
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
        });
      }
    }

    await saveObservation(sb, d.id, power, temp, now);
  }

  await events.recordMany(sb, found);
  // 갱신 **전**의 스냅샷을 함께 돌려준다 — 스윕이 '계속 켜져 있던 것'과 '방금 켜진 것'을
  // 가르려면 이 값이 필요하고, 여기서 이미 saveObservation으로 덮어썼기 때문이다.
  return { onsite: found.length, previous: watching };
}
