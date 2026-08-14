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
import { checkConnectivity } from "../automation/connectivity.ts";
import { flush } from "../automation/notify.ts";
import { recordHeartbeat, syncWatchdogWebhook } from "../automation/heartbeat.ts";
import { detectOnsite } from "../automation/observe.ts";
import { firePrep, fireShutdown } from "../automation/schedule.ts";
import { record, recordSystemError } from "../automation/events.ts";
import { claimTransition, fetchRecent, type Reservation } from "../automation/store.ts";
import { sweepSms } from "../sms/sweep.ts";
import { type CleaningSweepResult, sweepCleaning } from "../cleaning/sweep.ts";
import { type Camera, type CameraState, listCameras } from "../cameras.ts";
import {
  CATCHUP_WINDOW_MINUTES,
  type DueState,
  dueState,
  endTime,
  handsOverToNext,
  isOccupied,
  isSweeping,
  prepDueState,
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
 *
 * `skip`은 **일부러 안 하는 경우**다(퇴실 종료만 넘긴다 — `handsOverToNext`). 실패가 아니라
 * 판단이므로 `status: "ok"`로 남겨 ❌를 달지 않는다. 그래도 장부에는 남긴다 — 퇴실했는데
 * 방이 켜져 있는 이유가 채널에 없으면, 그건 자동화가 죽은 것과 구분되지 않는다.
 */
async function runTransition(
  sb: SupabaseClient,
  r: Reservation,
  // 판정을 호출부에서 받는다 — 입실과 퇴실의 만료 경계가 다르기 때문이다.
  // 입실은 준비 시각(입실 15분 전)에 돌지만 만료는 **입실 시각**을 기준으로 재고(checkinDueState),
  // 퇴실은 종료 시각이 곧 실행 시각이라 일반 dueState를 쓴다. 여기서 target 하나로 뭉뚱그리면
  // 당일 즉시 예약의 준비가 통째로 스킵되면서 채널엔 장애처럼 읽히는 실패만 남는다.
  state: DueState,
  now: Date,
  label: string,
  column: "checkin_automation_at" | "checkout_automation_at",
  fire: () => Promise<void>,
  /** 실행하지 **않을** 사유. null이면 평소대로 실행한다. */
  skip?: () => string | null,
): Promise<boolean> {
  if (state === "wait") return false;
  if (!await claimTransition(sb, r.id, column, now)) return false;

  const note = (status: "ok" | "failed", detail: string) =>
    record(sb, {
      device_id: null,
      kind: TRANSITION_KIND[column],
      action: TRANSITION_KIND[column],
      status,
      detail,
    });

  // **선점 뒤에, 만료보다 먼저** 본다.
  //
  // 선점 앞에 두면 컬럼이 빈 채로 남아 다음 틱이 같은 예약을 다시 잡고, 캐치업 창(10분)을
  // 넘기는 순간 "퇴실 종료를 못 했다"는 ❌가 뜬다 — 정상 인계가 매번 사고처럼 보인다.
  // 만료 뒤에 두면 늦게 돈 인계가 실패로 기록된다. 넘겨주는 중이라면 늦었든 아니든
  // 안 하는 것이 맞고, 그걸 '못 했다'로 적으면 거짓이다.
  const reason = skip?.();
  if (reason) {
    console.info(`${label} 건너뜀 — ${reason}`, r.id);
    await note("ok", reason);
    return false;
  }

  if (state === "expired") {
    console.warn(`${label} 창 만료 — 건너뜀`, r.id);
    await note("failed", `${label} 시각을 ${CATCHUP_WINDOW_MINUTES}분 넘겨 실행하지 못했습니다`);
    return false;
  }

  try {
    await fire();
    return true;
  } catch (e) {
    console.error(`${label} 실패`, r.id, e);
    await note("failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * 진짜 진입점. **틱 전체를 감싼다** — 아래 개별 서브시스템 격리(문자·청소·알림·연결 점검)는
 * 이미 잡히는 예외만 막는다. `fetchRecent`·`db.listDevices`·`claimTransition`처럼 그 밖의
 * 어디서든 예외가 새면 이 없이는 `automate`가 그대로 500을 내고 끝난다 — pg_net이 비동기라
 * `cron.job_run_details`엔 '성공'만 남는다(#70). 그러면 "시스템 오류를 감지해 알린다"는
 * 정확히 이 경우에 조용해진다.
 *
 * 원인을 장부에 남기고 **그 자리에서 보내본 다음 다시 던진다.**
 *
 * 예전엔 '다음 틱의 `flush()`가 보낸다'에 기대었다. 일시적 실패에서만 맞는 가정이다 —
 * `flush()`는 `runAutomation`의 **끝**에서만 불리므로, `fetchRecent` 같은 초입이 지속적으로
 * 죽으면 매 틱 그 줄에 도달하지 못해 `automate_failed`가 쌓기만 하고 한 건도 발송되지
 * 않는다. 게다가 미발송분은 7일 뒤 정리 크론이 지워 증거까지 사라진다
 * (20260807120000). 경보 벨이 불난 건물 안에 있으면 사실상 없는 것이다.
 */
export async function automate(sb: SupabaseClient) {
  const now = new Date();
  try {
    return await runAutomation(sb, now);
  } catch (e) {
    console.error("automate 전체 실패 — 원인을 장부에 남기고 바로 알린다", e);
    await recordSystemError(sb, "automate_failed", e instanceof Error ? e.message : String(e), now);
    // 이름표를 못 만든 상태라 빈 Map을 넘긴다 — 기기명 대신 id가 찍힐 뿐, 안 가는 것보다 낫다.
    // 이것까지 실패해도 원래 예외를 가리지 않는다 — 진짜 원인은 `e` 쪽이다.
    try {
      await flush(sb, new Map(), now);
    } catch (flushError) {
      console.error("실패 알림 발송도 실패했다 — 다음 틱이 다시 시도한다", flushError);
    }
    throw e;
  }
}

async function runAutomation(sb: SupabaseClient, now: Date) {
  const reservations = await fetchRecent(sb, now);

  // 이용 중이면 매 틱 신선하게, 빈 시간이면 10분까지 묵힌 것을 그대로 쓴다 — 후자는 ThinQ
  // 호출을 1/10로 줄인다. 조명은 MQTT로 상태가 밀려 올라와 이 값과 무관하게 항상 최신이다.
  const active = isOccupied(reservations, now) || isSweeping(reservations, now);
  const thinqMaxAge = active ? undefined : IDLE_THINQ_MAX_AGE_SECONDS;

  // 틱당 한 번만 부른다. 이젠 알림을 위해 항상 불러야 한다 — 현장 조작은 예약과 무관하게
  // 일어나고, 그걸 보려면 상태를 봐야 하기 때문이다.
  let devices: DeviceList | null = null;
  // 이번 틱에 실제로 ThinQ를 다시 물어본 기기의 실패 원인 — 연결 끊김 알림의 "왜"를 채운다.
  // list()에 매개변수로 넘겨 채워 받는다(반환값이 아니다) — list()의 결과는 손님에게도
  // 그대로 내려가는 공개 응답이라, 여기 새 필드를 얹으면 응답 스키마가 원치 않게 늘어난다.
  const thinqErrors = new Map<string, string>();
  const getDevices = async (): Promise<DeviceList> => {
    if (!devices) devices = (await list(sb, thinqMaxAge, thinqErrors)).devices;
    return devices;
  };

  let prepFired = 0;
  let shutdownFired = 0;

  for (const r of reservations) {
    if (!r.checkin_automation_at) {
      const ok = await runTransition(
        // `checkinDueState`가 아니라 `prepDueState`다 — 앞 손님이 아직 방에 있으면
        // 그 퇴실 시각까지 미룬다. 그대로 쏘면 앞 손님의 마지막 15분에 에어컨과 조명이
        // 제멋대로 바뀐다(형운 결정, 2026-08-14).
        sb, r, prepDueState(reservations, r, now), now, "입실 준비", "checkin_automation_at",
        async () => await firePrep(sb, await getDevices()),
      );
      if (ok) prepFired++;
    }
    if (!r.checkout_automation_at) {
      const ok = await runTransition(
        sb, r, dueState(endTime(r), now), now, "퇴실 종료", "checkout_automation_at",
        async () => await fireShutdown(sb, await getDevices()),
        // 다음 예약이 15분 안에 붙어 있으면 그 준비가 **이미 돌았다.** 여기서 전원을 내리면
        // 방금 맞춘 26도·냉방과 조명이 그대로 되돌아가 다음 손님이 꺼진 방으로 들어온다.
        () =>
          handsOverToNext(reservations, r, now)
            ? "다음 예약의 입실 준비가 이미 시작돼 전원을 내리지 않았습니다"
            : null,
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
      await recordSystemError(sb, "observe_failed", e instanceof Error ? e.message : String(e), now);
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

  // 연결 상태 점검. **위 판정 체인(스윕/온도/유휴)과 달리 항상 돈다** — 예약 유무나 방금
  // 전환이 일어났는지와 무관하게, 조명·냉난방·CCTV는 언제든 죽어 있을 수 있다. 이용 중에
  // CCTV가 끊기는 것이 가장 비싼 경우인데, 그건 하필 `isOccupied` 분기라 `idle`(빈 시간
  // 전용)로는 못 잡는다. 카메라는 여기서 처음 불러온다 — automate가 지금까진 CCTV를
  // 아예 보지 않았다.
  let deviceOffline = 0;
  let cameraOffline = 0;
  let cameraPairs: Array<[Camera, CameraState]> = [];
  try {
    const current = await getDevices();
    cameraPairs = await listCameras(sb);
    const result = await checkConnectivity(sb, current, cameraPairs, thinqErrors, now);
    deviceOffline = result.deviceAlerts;
    cameraOffline = result.cameraAlerts;
  } catch (e) {
    console.error("연결 상태 점검 실패 — 자동화 결과는 유지한다", e);
    await recordSystemError(sb, "connectivity_failed", e instanceof Error ? e.message : String(e), now);
  }

  // 손님 안내 문자. **기기 제어와 완전히 분리한다** — 여기서 예외가 새면 아래 알림이 안 가고,
  // 반대로 기기 자동화가 실패한 틱에도 문자는 나가야 한다(입실 준비가 실패했다고 손님에게
  // 길 안내를 안 보낼 이유가 없다). 위의 `prepFired` 스킵 조건에도 걸지 않는다 —
  // 그건 기기 상태 캐시가 아직 안 따라왔다는 뜻이지, 문자와는 무관하다.
  let smsResult = { sent: 0, failed: 0, no_phone: 0, expired: 0 };
  try {
    smsResult = await sweepSms(sb, reservations, now);
  } catch (e) {
    console.error("자동 문자 스윕 실패 — 기기 자동화 결과는 유지한다", e);
    await recordSystemError(sb, "sms_sweep_failed", e instanceof Error ? e.message : String(e), now);
  }

  // 청소 담당자 안내. 같은 이유로 또 한 번 격리한다 — 손님 문자가 실패해도 청소 안내는
  // 나가야 하고, 반대도 마찬가지다. 같은 `reservations` 배열을 쓰는 것이 중요하다 —
  // 따로 조회하면 기기·손님문자·청소안내가 서로 다른 예약 목록을 보는 순간이 생긴다.
  let cleaningResult: CleaningSweepResult = { digest: 0, update: 0, quiet: 0, failed: 0 };
  try {
    cleaningResult = await sweepCleaning(sb, reservations, now);
  } catch (e) {
    console.error("청소 안내 스윕 실패 — 앞의 결과는 유지한다", e);
    await recordSystemError(sb, "cleaning_sweep_failed", e instanceof Error ? e.message : String(e), now);
  }

  // 알림은 마지막에 한 번 — 이번 틱에 생긴 것까지 모아 종류별로 묶어 보낸다.
  // 이게 실패해도 자동화 결과를 되돌리지 않는다(notify가 예외를 밖으로 던지지 않는다).
  // `devices`는 클로저(getDevices) 안에서 채워져 TS가 여기서는 여전히 null로 본다 —
  // 명시 타입으로 그 좁힘을 끊는다.
  const loaded: DeviceList = devices ?? [];
  // 카메라 이름도 같은 맵에 합친다 — device_id와 camera_id는 서로 다른 UUID 공간이라
  // 충돌하지 않고, `message.ts`의 이름 해석이 대상 종류를 몰라도 그대로 동작한다.
  const names = new Map<string, string>([
    ...loaded.map((d) => [d.id, d.name] as const),
    ...cameraPairs.map(([c]) => [c.id, c.name] as const),
  ]);
  let notified = 0;
  try {
    notified = await flush(sb, names, now);
  } catch (e) {
    // 같은 이유로 삼킨다. 알림이 안 갔다고 이미 끝난 자동화를 실패로 만들지 않는다.
    console.error("알림 발송 실패 — 자동화 결과는 유지한다", e);
    await recordSystemError(sb, "notify_flush_failed", e instanceof Error ? e.message : String(e), now);
  }

  // 한 바퀴 완주를 남긴다. **정상 종료 직전이어야 한다** — 앞에서 던졌으면 갱신되지 않고
  // 낡아, 게이트 밖의 감시 잡이 정지를 알아차린다(20260813130000). 그게 이 설계의 목적이다.
  await recordHeartbeat(sb, now);

  // 워치독은 SQL이라 Edge Function 시크릿을 못 읽는다 — 주소만 내려보낸다(heartbeat.ts).
  // 결과를 응답에 실어 '설정됐는지'를 URL 노출 없이 확인할 수 있게 한다.
  const watchdog = await syncWatchdogWebhook(sb);

  return {
    watchdog,
    prep_fired: prepFired,
    shutdown_fired: shutdownFired,
    swept,
    temp_corrected: tempCorrected,
    onsite,
    idle,
    device_offline: deviceOffline,
    camera_offline: cameraOffline,
    notified,
    sms: smsResult,
    cleaning: cleaningResult,
    reservations: reservations.length,
  };
}
