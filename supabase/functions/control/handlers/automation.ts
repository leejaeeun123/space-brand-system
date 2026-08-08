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
import { alertIdleDevices, enforceTempFloor, sweepIdleDevices } from "../automation/enforce.ts";
import { flush } from "../automation/notify.ts";
import { detectOnsite } from "../automation/observe.ts";
import { firePrep, fireShutdown } from "../automation/schedule.ts";
import { record } from "../automation/events.ts";
import { claimTransition, fetchRecent, type Reservation } from "../automation/store.ts";
import {
  CATCHUP_WINDOW_MINUTES,
  dueState,
  endTime,
  isOccupied,
  isSweeping,
  prepTime,
  sweepElapsedMinutes,
} from "../automation/windows.ts";

type DeviceList = Awaited<ReturnType<typeof list>>["devices"];

/**
 * 예약이 없는 시간의 ThinQ 신선도. 틱은 1분마다 돌지만 에어컨은 10분에 한 번만 물어본다.
 *
 * 여기를 줄이면 빈 시간 현장 조작을 빨리 알지만, ThinQ 호출이 그만큼 늘어난다 — 이 레포는
 * PAT 만료를 재시도조차 못 하게 막아둔 만큼 ThinQ 인증이 약해 부하를 늘리는 게 공짜가 아니다
 * (형운 결정, 2026-08-07). 조명은 MQTT push라 이 값과 무관하게 24시간 즉시 잡힌다.
 */
const IDLE_THINQ_MAX_AGE_SECONDS = 600;

/**
 * 전환이 실패했을 때 장부에 적을 kind와 action — 무엇을 하려던 참이었는지를 남긴다.
 * 둘을 같은 값으로 둔다 — 기기가 없는 사건이라 적을 명령명이 따로 없다.
 */
const TRANSITION_KIND = {
  checkin_automation_at: "prep",
  checkout_automation_at: "shutdown",
} as const;

/**
 * 예정된 전환 하나를 처리한다.
 *
 * **선점 먼저, 실행 나중.** `automate`는 anon key로 누구나 부를 수 있어 두 호출이 나란히
 * 들어올 수 있는데, 예전 순서(`확인 → 실행 → 표시`)는 둘 다 확인을 통과해 **입실 준비를
 * 두 번 쏠 수 있었다.** 선점이 그걸 막는다 — 알림이 `claimPending`으로 중복을 막는 것과
 * 같은 방식이다(`store.claimTransition`).
 *
 * 창을 넘겼으면(`expired`) 실행하지 않는다 — 지난 예약을 매 틱 영원히 다시 시도하지 않기
 * 위해서다. **다만 조용히 넘기지 않는다.** 만료도 실패도 장부에 남겨 채널에 뜨게 한다.
 * 예전엔 `console.warn` 한 줄이 전부였고, 그래서 함수가 10분 넘게 죽어 퇴실 종료를 통째로
 * 놓친 밤에도 채널은 아무 말이 없었다 — 무인 공간에서 조용한 실패는 실패가 아니라 사고다.
 *
 * 이 실패 기록만 `device_id`가 null이다. 전환이 시작조차 못 한 것은 특정 기기의 일이 아니고,
 * 기기를 하나 골라 적으면 거짓이다. 개별 명령의 실패는 지금처럼 `dispatch.issue`가 기기별로
 * 남긴다 — 그건 실제로 그 기기의 일이다.
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
  if (!await claimTransition(sb, r.id, column, now)) return false;

  const failed = (detail: string) =>
    record(sb, {
      device_id: null,
      kind: TRANSITION_KIND[column],
      action: TRANSITION_KIND[column],
      status: "failed",
      detail,
    });

  if (state === "expired") {
    console.warn(`${label} 창 만료 — 건너뜀`, r.id);
    await failed(`${label} 시각을 ${CATCHUP_WINDOW_MINUTES}분 넘겨 실행하지 못했습니다`);
    return false;
  }

  try {
    await fire();
    return true;
  } catch (e) {
    console.error(`${label} 실패`, r.id, e);
    await failed(e instanceof Error ? e.message : String(e));
    return false;
  }
}

export async function automate(sb: SupabaseClient) {
  const now = new Date();
  const reservations = await fetchRecent(sb, now);

  // 이용 중이면 매 틱 신선하게, 빈 시간이면 10분까지 묵힌 것을 그대로 쓴다 — 후자는 ThinQ
  // 호출을 1/10로 줄인다. 조명은 MQTT로 상태가 밀려 올라와 이 값과 무관하게 항상 최신이다.
  const active = isOccupied(reservations, now) || isSweeping(reservations, now);
  const thinqMaxAge = active ? undefined : IDLE_THINQ_MAX_AGE_SECONDS;

  // 틱당 한 번만 부른다. 이젠 알림을 위해 항상 불러야 한다 — 현장 조작은 예약과 무관하게
  // 일어나고, 그걸 보려면 상태를 봐야 하기 때문이다.
  let devices: DeviceList | null = null;
  const getDevices = async (): Promise<DeviceList> => {
    if (!devices) devices = (await list(sb, thinqMaxAge)).devices;
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

  // 전환이 방금 일어난 틱에는 관측·강제를 건너뛴다 — 방금 보낸 명령이 상태 캐시에 반영되기
  // 전이라(조명은 아직 큐에도 안 나갔다) 지금 읽은 상태로 판단하면 방금 켠 것을 도로 끄거나,
  // 방금 맞춘 26도를 낮은 값으로 오인한다. 1분 뒤 다음 틱이 제대로 본다.
  let swept = 0;
  let tempCorrected = 0;
  let onsite = 0;
  let idle = 0;
  if (!prepFired && !shutdownFired) {
    const current = await getDevices();

    // 관측이 먼저다 — 강제가 먼저 돌면 그것이 만든 변화까지 현장 조작 후보로 잡힌다.
    //
    // ⚠️ 여기서 절대 던지지 않는다. 관측은 '알림을 위한 부가 기능'이고 그 아래 스윕·온도 하한은
    // **제어 안전장치**다. 관측이 던지면 그 틱의 냉난방이 안 꺼진다 — 새로 들어온 관심사가
    // 기존 안전장치를 인질로 잡는 구조가 된다. 관측·알림은 제어보다 항상 후순위다.
    try {
      onsite = await detectOnsite(sb, current, now);
    } catch (e) {
      console.error("현장 조작 판별 실패 — 제어는 계속한다", e);
    }

    if (isSweeping(reservations, now)) {
      swept = await sweepIdleDevices(sb, current, sweepElapsedMinutes(reservations, now) ?? 0, now);
    } else if (isOccupied(reservations, now)) {
      // 이용 중일 때만 온도를 본다 — 빈 시간의 냉난방은 스윕이 어차피 끈다.
      tempCorrected = await enforceTempFloor(sb, current, now);
    } else {
      // 예약도 스윕 창도 없는 시간 — **끄는 규칙이 하나도 안 도는 구간**이다. 여기서만
      // 유휴 경보가 돈다(왜 끄지 않고 알리기만 하는지는 `enforce.ts`가 설명한다).
      idle = await alertIdleDevices(sb, current, now);
    }
  }

  // 알림은 마지막에 한 번 — 이번 틱에 생긴 것까지 모아 종류별로 묶어 보낸다.
  // 이게 실패해도 자동화 결과를 되돌리지 않는다(notify가 예외를 밖으로 던지지 않는다).
  // `devices`는 클로저(getDevices) 안에서 채워져 TS가 여기서는 여전히 null로 본다 —
  // 명시 타입으로 그 좁힘을 끊는다.
  const loaded: DeviceList = devices ?? [];
  const names = new Map(loaded.map((d) => [d.id, d.name] as const));
  let notified = 0;
  try {
    notified = await flush(sb, names, now);
  } catch (e) {
    // 같은 이유로 삼킨다. 알림이 안 갔다고 이미 끝난 자동화를 실패로 만들지 않는다.
    console.error("알림 발송 실패 — 자동화 결과는 유지한다", e);
  }

  return {
    prep_fired: prepFired,
    shutdown_fired: shutdownFired,
    swept,
    temp_corrected: tempCorrected,
    onsite,
    idle,
    notified,
    reservations: reservations.length,
  };
}
