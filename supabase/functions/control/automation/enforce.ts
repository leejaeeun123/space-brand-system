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
import { issue } from "./dispatch.ts";
import { recordMany } from "./events.ts";
import { SWEEP_WINDOW_MINUTES } from "./windows.ts";
import { clearTempFloor, fetchWatch, startTempFloor, type Watch } from "./store.ts";

type DeviceList = Awaited<ReturnType<typeof list>>["devices"];

/** 손님이 이 아래로 내려도 5분 뒤 여기로 되돌린다(형운 지시, 2026-08-07). */
const TEMP_FLOOR = 24;
/** 하한 미만으로 이만큼 '가동'한 뒤에 되돌린다 — 잠깐 세게 트는 것 자체는 막지 않는다. */
const TEMP_GRACE_MINUTES = 5;

/** 스윕 창(10분)의 마지막 틱. 여기서 잔존 기기를 1회 알린다. */
const SWEEP_LAST_TICK_MINUTES = SWEEP_WINDOW_MINUTES - 1;

/**
 * 퇴실 후 스윕 — 켜져 있는 기기를 끈다.
 *
 * **`power === 'ON'`인 것만 건드린다.** `null`('모름')을 'OFF'로도 'ON'으로도 보지 않는 것이
 * 이 레포의 규칙이고, 상태를 한 번도 못 받은 기기에 10분 내내 매 틱 명령을 쏘면 조명 큐만
 * 쌓인다. 퇴실 시각의 '전체 끄기'는 `schedule.ts`가 이미 한 번 보냈다.
 *
 * **명령은 매 틱 계속 보내되, 알림은 '방금 켜진' 것만 낸다**(형운 결정, 2026-08-07).
 * 기기가 응답하지 않아 상태가 계속 'ON'으로 남으면 10분 내내 매 분 알림이 가는데, 하필
 * 그때가 채널이 조용해야 할 때다. 직전 관측도 'ON'이었다면 이미 알린 상태의 연장이므로
 * 조용히 보낸다 — 명령을 멈추는 게 아니라 알림만 멈춘다.
 */
export async function sweepIdleDevices(
  sb: SupabaseClient,
  devices: DeviceList,
  previous: Map<string, Watch>,
  elapsedMinutes: number,
): Promise<number> {
  const on = devices.filter((d) => d.capabilities.includes("power") && d.state?.power === "ON");
  if (!on.length) return 0;

  // 창의 마지막 틱. 여기서도 켜져 있다 = 10분간 매 분 껐는데 안 꺼졌다는 뜻이다.
  // 조명 명령은 큐에 넣기만 하므로(`command.ts`) 성공 응답이 곧 소등이 아니다 — 이 신호가
  // 없으면 에이전트가 죽어 조명이 밤새 켜져 있어도 채널엔 '퇴실 종료 성공'만 남는다.
  const lastTick = elapsedMinutes >= SWEEP_LAST_TICK_MINUTES;
  if (lastTick) {
    await recordMany(
      sb,
      on.map((d) => ({
        device_id: d.id,
        kind: "sweep" as const,
        action: "power_off",
        status: "failed" as const,
        detail: `퇴실 후 ${SWEEP_WINDOW_MINUTES}분간 껐는데도 켜져 있습니다`,
      })),
    );
  }

  const results = await Promise.allSettled(
    on.map((d) =>
      issue(sb, { device_id: d.id, command: "power_off" }, "sweep", {
        // 직전에도 켜져 있었다 = 새 사건이 아니다. 꺼졌다가 다시 켜진 것만 알린다.
        silent: previous.get(d.id)?.lastPower === "ON",
      })
    ),
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

  const watching = await fetchWatch(sb);
  const settled: string[] = [];
  let corrected = 0;

  for (const d of hvac) {
    const target = Number((d.state?.attrs as Record<string, unknown> | undefined)?.target_temp);
    const below = d.state?.power === "ON" && Number.isFinite(target) && target < TEMP_FLOOR;

    if (!below) {
      if (watching.get(d.id)?.belowSince) settled.push(d.id);
      continue;
    }

    const since = watching.get(d.id)?.belowSince ?? null;
    if (!since) {
      await startTempFloor(sb, d.id, now);
      continue;
    }
    if ((now.getTime() - since.getTime()) / 60000 < TEMP_GRACE_MINUTES) continue;

    try {
      await issue(sb, { device_id: d.id, command: "set_temp", value: TEMP_FLOOR }, "temp_floor");
      corrected++;
      console.warn(`온도 하한 강제 — ${d.id}를 ${target}도에서 ${TEMP_FLOOR}도로 되돌렸다`);
    } catch (e) {
      // 실패하면 시계를 지금으로 **민다**(해제가 아니라 백오프). 그대로 두면 다음 틱에도
      // 5분이 지난 상태라 매 분 재시도하고 매 분 실패 알림이 나간다 — PAT가 만료된 3시간
      // 예약 하나에 175건이 쌓인다. 스윕은 10분 창으로 유계인데 여기는 상한이 없었다.
      // 미는 것으로 재시도 주기가 5분이 되고 알림도 같은 주기로 묶인다.
      console.error("온도 하한 강제 실패 — 5분 뒤 다시 시도한다", d.id, e);
      await startTempFloor(sb, d.id, now, { force: true });
      continue;
    }
    settled.push(d.id);
  }

  await clearTempFloor(sb, settled);
  return corrected;
}
