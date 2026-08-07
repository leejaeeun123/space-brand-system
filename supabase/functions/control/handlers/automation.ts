/**
 * 예약 자동화 진입점 — 단일 책임: 매 틱 한 번, 판정과 실행을 이어 붙인다.
 *
 * pg_cron이 1분마다 이 action(`automate`)만 찌른다. '어떤 예약이 대상인가'는 여기가 판단한다
 * (이유는 마이그레이션 `20260807000000`의 주석 참조).
 *
 * 하는 일이 두 종류다 —
 *   **예정된 전환**(`automation/schedule.ts`): 입실 15분 전 준비 · 퇴실 시각 종료. 예약당 한 번.
 *   **지속 강제**(`automation/enforce.ts`): 퇴실 후 스윕 · 온도 하한. 창이 열린 동안 매 틱.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { list } from "./list.ts";
import { enforceTempFloor, sweepIdleDevices } from "../automation/enforce.ts";
import { firePrep, fireShutdown } from "../automation/schedule.ts";
import { fetchRecent, markAutomated, type Reservation } from "../automation/store.ts";
import {
  dueState,
  endTime,
  isOccupied,
  isSweeping,
  prepTime,
} from "../automation/windows.ts";

type DeviceList = Awaited<ReturnType<typeof list>>["devices"];

/**
 * 예정된 전환 하나를 처리한다.
 *
 * 창을 넘겼으면(`expired`) 실행하지 않고 **기록만** 남긴다 — 안 남기면 지난 예약을 매 틱
 * 영원히 다시 시도한다. 실행 실패도 마찬가지로 기록한다: 되돌릴 수 없는 실패를 1분마다
 * 재시도하면 기기에 같은 명령이 쌓이기만 한다.
 */
async function runTransition(
  sb: SupabaseClient,
  r: Reservation,
  target: Date,
  now: Date,
  label: string,
  column: "checkin_automation_at" | "checkout_automation_at",
  fire: () => Promise<void>,
): Promise<boolean> {
  const state = dueState(target, now);
  if (state === "wait") return false;

  let fired = false;
  if (state === "fire") {
    try {
      await fire();
      fired = true;
    } catch (e) {
      console.error(`${label} 실패`, r.id, e);
    }
  } else {
    console.warn(`${label} 창 만료 — 건너뜀`, r.id);
  }

  await markAutomated(sb, r.id, column, now);
  return fired;
}

export async function automate(sb: SupabaseClient) {
  const now = new Date();
  const reservations = await fetchRecent(sb, now);

  // 기기 목록은 실제로 할 일이 있을 때만, 그것도 틱당 한 번만 부른다 — 아무 예약도 걸리지
  // 않는 대부분의 분에는 list()도 ThinQ 왕복도 일어나지 않는다.
  let devices: DeviceList | null = null;
  const getDevices = async (): Promise<DeviceList> => {
    if (!devices) devices = (await list(sb)).devices;
    return devices;
  };

  let prepFired = 0;
  let shutdownFired = 0;

  for (const r of reservations) {
    if (!r.checkin_automation_at) {
      const ok = await runTransition(
        sb, r, prepTime(r), now, "입실 준비", "checkin_automation_at",
        async () => await firePrep(sb, await getDevices()),
      );
      if (ok) prepFired++;
    }
    if (!r.checkout_automation_at) {
      const ok = await runTransition(
        sb, r, endTime(r), now, "퇴실 종료", "checkout_automation_at",
        async () => await fireShutdown(sb, await getDevices()),
      );
      if (ok) shutdownFired++;
    }
  }

  // 전환이 방금 일어난 틱에는 강제를 건너뛴다 — 방금 보낸 명령이 상태 캐시에 반영되기 전이라
  // (조명은 아직 큐에도 안 나갔다) 지금 읽은 상태로 판단하면 방금 켠 것을 도로 끄거나,
  // 방금 맞춘 26도를 낮은 값으로 오인한다. 1분 뒤 다음 틱이 제대로 본다.
  let swept = 0;
  let tempCorrected = 0;
  if (!prepFired && !shutdownFired) {
    if (isSweeping(reservations, now)) {
      swept = await sweepIdleDevices(sb, await getDevices());
    } else if (isOccupied(reservations, now)) {
      // 이용 중일 때만 본다 — 빈 시간의 냉난방은 스윕이 어차피 끄고, ThinQ를 24시간 찌를
      // 이유도 없다.
      tempCorrected = await enforceTempFloor(sb, await getDevices(), now);
    }
  }

  return {
    prep_fired: prepFired,
    shutdown_fired: shutdownFired,
    swept,
    temp_corrected: tempCorrected,
    reservations: reservations.length,
  };
}
