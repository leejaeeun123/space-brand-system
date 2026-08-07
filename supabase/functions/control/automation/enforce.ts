/**
 * 지속 강제 — 단일 책임: 한 번의 전환으로 끝나지 않고 **매 틱 다시 확인해야 하는** 두 규칙.
 *
 *   1. 퇴실 후 스윕 — 퇴실 10분 안에 켜지는 기기는 계속 다시 끈다.
 *   2. 온도 하한 — 24도 미만으로 5분 넘게 돌면 24도로 되돌린다.
 *
 * `schedule.ts`(예정된 전환)와 나눠 둔 이유가 이것이다 — 저쪽은 예약당 한 번 실행하고 기록으로
 * 닫히지만, 여기는 창이 열려 있는 동안 반복이 곧 기능이다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { list } from "../handlers/list.ts";
import { command } from "../handlers/command.ts";
import { clearTempFloorWatch, fetchTempFloorWatch, startTempFloorWatch } from "./store.ts";

type DeviceList = Awaited<ReturnType<typeof list>>["devices"];

/** 손님이 이 아래로 내려도 5분 뒤 여기로 되돌린다(형운 지시, 2026-08-07). */
const TEMP_FLOOR = 24;
/** 하한 미만으로 이만큼 '가동'한 뒤에 되돌린다 — 잠깐 세게 트는 것 자체는 막지 않는다. */
const TEMP_GRACE_MINUTES = 5;

/**
 * 퇴실 후 스윕 — 켜져 있는 기기를 끈다.
 *
 * **`power === 'ON'`인 것만 건드린다.** `null`('모름')을 'OFF'로도 'ON'으로도 보지 않는 것이
 * 이 레포의 규칙이고, 상태를 한 번도 못 받은 기기에 10분 내내 매 틱 명령을 쏘면 조명 큐만
 * 쌓인다. 퇴실 시각의 '전체 끄기'는 `schedule.ts`가 이미 한 번 보냈다.
 */
export async function sweepIdleDevices(sb: SupabaseClient, devices: DeviceList): Promise<number> {
  const on = devices.filter((d) => d.capabilities.includes("power") && d.state?.power === "ON");
  if (!on.length) return 0;

  const results = await Promise.allSettled(
    on.map((d) => command(sb, { device_id: d.id, command: "power_off" })),
  );
  for (const r of results) {
    if (r.status === "rejected") console.warn("퇴실 후 스윕 — 끄기 실패", r.reason);
  }
  console.warn(`퇴실 후 스윕 — 켜져 있던 기기 ${on.length}대를 껐다`);
  return on.length;
}

/**
 * 온도 하한 강제.
 *
 * '가동 중'일 때만 시계를 돌린다 — 요구사항이 "5분간 **가동**하다"이고, 꺼진 기기의 목표온도는
 * 아무 일도 하지 않기 때문이다. 그래서 전원이 꺼지면 시계도 해제된다(다시 켜면 처음부터).
 *
 * 비교는 `< 24`다. 정확히 24도면 이미 하한이라 되돌릴 것이 없고, `<=`로 두면 매 틱 같은 값을
 * 다시 쓰는 명령이 나간다.
 */
export async function enforceTempFloor(
  sb: SupabaseClient,
  devices: DeviceList,
  now: Date,
): Promise<number> {
  const hvac = devices.filter((d) => d.kind === "hvac" && d.capabilities.includes("temp"));
  if (!hvac.length) return 0;

  const watching = await fetchTempFloorWatch(sb);
  const settled: string[] = [];
  let corrected = 0;

  for (const d of hvac) {
    const target = Number((d.state?.attrs as Record<string, unknown> | undefined)?.target_temp);
    const below = d.state?.power === "ON" && Number.isFinite(target) && target < TEMP_FLOOR;

    if (!below) {
      if (watching.has(d.id)) settled.push(d.id);
      continue;
    }

    const since = watching.get(d.id);
    if (!since) {
      await startTempFloorWatch(sb, d.id, now);
      continue;
    }
    if ((now.getTime() - since.getTime()) / 60000 < TEMP_GRACE_MINUTES) continue;

    try {
      await command(sb, { device_id: d.id, command: "set_temp", value: TEMP_FLOOR });
      corrected++;
      console.warn(`온도 하한 강제 — ${d.id}를 ${target}도에서 ${TEMP_FLOOR}도로 되돌렸다`);
    } catch (e) {
      // 되돌리기가 실패하면 감시를 유지한다 — 해제해 버리면 5분을 처음부터 다시 세게 된다.
      console.error("온도 하한 강제 실패", d.id, e);
      continue;
    }
    settled.push(d.id);
  }

  await clearTempFloorWatch(sb, settled);
  return corrected;
}
