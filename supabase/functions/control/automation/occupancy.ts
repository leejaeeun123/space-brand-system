/**
 * 퇴실 독려 — 단일 책임: 퇴실 후 창 안에 사람이 남아 있는지 판단하고 **알리기만** 한다.
 *
 * 스윕(`enforce.ts`)이 "퇴실했는데 기기가 켜져 있다"를 다루는 자리 바로 옆이다. 다른 점은
 * 대상이 기기가 아니라 **사람**이라는 것이고, 그래서 **아무것도 끄지 않는다** — 사람에게
 * 할 수 있는 자동 조치가 없다. 운영자가 보고 판단해 연락한다(형운 결정, 2026-08-17).
 *
 * ── 영상은 여기까지 오지 않는다 ──────────────────────────────────────────────
 * 현장 에이전트가 카메라에서 ONVIF로 **"움직임이 있었다"는 시각 하나**만 받아
 * `camera_motion`에 적는다. 프레임도 스냅샷도 서버로 올라오지 않고, 이력도 쌓지 않는다
 * (마이그레이션 20260818000000의 주석 참조). 판정에 필요한 것이 그것뿐이기 때문이고,
 * 필요 없는 것을 보관하지 않는 것이 §25의 태도이기도 하다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { fetchLatestByAction, recordMany, recordSystemError } from "./events.ts";
import { isSweeping, sweepElapsedMinutes, type ReservationWindow } from "./windows.ts";

/**
 * 퇴실 시각 직후 이만큼은 보지 않는다.
 *
 * **손님이 나가는 행위 자체가 라운지 카메라에 잡히기 때문이다.** 짐을 싸고 문으로 걸어가는
 * 것이 퇴실 시각 전후 1~2분에 일어나므로, 창을 퇴실 정각에 열면 **정상적으로 나가는 손님마다**
 * "아직 사람이 있습니다"가 뜬다. 매번 뜨는 경고는 사람이 무시하는 법을 배우고, 그 순간
 * 진짜 초과 손님도 같이 묻힌다(`message.ts`가 ❌ 남용을 경계하는 것과 같은 이유).
 *
 * ⚠️ **형운의 지시는 "퇴실 시점 이후 10분"이었고 이 유예는 그 위에 얹은 것이다**(2026-08-17).
 * 0으로 두면 지시에 더 충실하지만 흔한 경우에 틀린 알림이 나간다. 값을 바꾸려면 여기 하나만
 * 고치면 되고, 창의 끝(`SWEEP_WINDOW_MINUTES`)은 건드리지 않는다.
 */
export const OVERDUE_GRACE_MINUTES = 3;

/**
 * 관측이 이보다 낡으면 '움직임 없음'이 아니라 **'모름'**이다.
 *
 * `cameras.ts`의 `CAMERA_STALE_AFTER_SECONDS`와 같은 값을 쓴다 — 같은 현장 에이전트가
 * 같은 카메라를 보는 관측이라 기준이 달라야 할 이유가 없다.
 */
export const MOTION_STALE_SECONDS = 180;

/**
 * 관측이 이보다 오래 끊겼으면 '감시자가 죽었다'가 아니라 **'감시를 접었다'**로 본다.
 *
 * 감시 구성은 현장 셸(`camera-relay-all.sh`의 `MOTION_PATHS`)에 있어 DB는 감시를 뺀 카메라를
 * 모른다 — `camera_motion`에는 그 카메라의 마지막 행이 영영 남는다. 그 잔행을 계속 '모름'으로
 * 치면 카메라를 뺀 날부터 퇴실이 있는 창마다 stale 경보가 끝없이 반복되고, 사람은 그 경보를
 * 무시하는 법을 배운다 — 경보가 지키려던 것을 경보 자신이 죽인다.
 *
 * 하루로 둔 이유: 감시자가 **진짜로 죽은 것**이라면 첫 경보들이 하루 안에 사람을 움직였어야
 * 하고, 하루가 지나도록 아무도 안 고쳤다면 반복 경보가 더 해줄 일은 없다. 감시를 되살리면
 * observed_at이 다시 신선해져 저절로 판정 대상으로 돌아온다.
 */
export const MOTION_RETIRED_SECONDS = 24 * 60 * 60;

/** `camera_motion` 한 행. 판정에 필요한 것만. */
export interface MotionReading {
  camera_id: string;
  /** 카메라가 이벤트에 실어 보낸 시각. null = 감시 시작 후 움직임 없음. */
  last_motion_at: string | null;
  /** 감시자가 마지막으로 정상 폴링한 시각. */
  observed_at: string;
}

export interface OverdueDecision {
  /** 창 안에서 움직임이 관측된 카메라. 비어 있으면 알릴 것이 없다. */
  moved: string[];
  /** 관측이 낡아 판단할 수 없는 카메라 — '없음'과 절대 합치지 않는다. */
  unknown: string[];
  /** `moved` 중 가장 최근 움직임 시각. 없으면 null. */
  latest: Date | null;
}

/**
 * 순수 판정 — DB도 시계도 건드리지 않는다(`occupancy.test.ts`가 이것만 검증한다).
 *
 * **낡은 관측을 먼저 걸러낸다.** 낡은 행의 `last_motion_at`은 창보다 이를 수밖에 없어서
 * 그냥 두면 조용히 '움직임 없음'에 섞인다 — 감시자가 죽은 채로 "아무도 없습니다"가 참이 되는
 * 바로 그 상태다. 낡음에도 결이 둘 있다: 방금 끊긴 것은 '모름'(경보 대상)이고, 하루 넘게
 * 끊긴 것은 '감시 종료'(판정에서 제외 — `MOTION_RETIRED_SECONDS`의 주석 참조)다.
 */
export function decideOverdue(
  motions: MotionReading[],
  lookFrom: Date,
  now: Date,
  staleSeconds = MOTION_STALE_SECONDS,
  retiredSeconds = MOTION_RETIRED_SECONDS,
): OverdueDecision {
  const moved: string[] = [];
  const unknown: string[] = [];
  let latest: Date | null = null;

  for (const m of motions) {
    const observed = Date.parse(m.observed_at);
    if (Number.isFinite(observed) && now.getTime() - observed > retiredSeconds * 1000) continue;
    if (!Number.isFinite(observed) || now.getTime() - observed > staleSeconds * 1000) {
      unknown.push(m.camera_id);
      continue;
    }
    if (!m.last_motion_at) continue;
    const at = Date.parse(m.last_motion_at);
    if (!Number.isFinite(at) || at < lookFrom.getTime()) continue;
    moved.push(m.camera_id);
    if (latest === null || at > latest.getTime()) latest = new Date(at);
  }

  return { moved, unknown, latest };
}

/** 판정의 기준선 셋 — 창 시작(퇴실 시각), 보기 시작(유예 반영), 중복 조회 기준. */
export function overdueWindow(elapsedMinutes: number, now: Date) {
  const sweepStart = new Date(now.getTime() - elapsedMinutes * 60_000);
  return {
    /** 퇴실 시각. */
    sweepStart,
    /** 이 시각 이후의 움직임만 센다. */
    lookFrom: new Date(sweepStart.getTime() + OVERDUE_GRACE_MINUTES * 60_000),
    /**
     * '이번 창에서 이미 알렸나'를 묻는 기준. **30초 여유는 `enforce.ts`에서 그대로 가져왔다** —
     * 틱이 정확히 창 시작에 맞춰 돌지 않아, 여유가 없으면 직전 알림 행을 놓치고 두 번 알린다.
     */
    since: new Date(sweepStart.getTime() - 30_000),
  };
}

async function loadMotions(sb: SupabaseClient): Promise<MotionReading[]> {
  const { data, error } = await sb
    .from("camera_motion")
    .select("camera_id,last_motion_at,observed_at");
  if (error) throw new Error(`움직임 관측 조회 실패: ${error.message}`);
  return (data ?? []) as MotionReading[];
}

/**
 * 퇴실 후 창에서 한 바퀴 판정한다. 알린 건수를 돌려준다.
 *
 * **창당 1회만 알린다**(형운 결정, 2026-08-17). 스윕이 "명령은 매 틱, 알림은 창당 1회"로
 * 정리해 둔 것과 같은 결이다 — 다만 여기는 보낼 명령이 없어서 알림이 곧 전부다.
 *
 * `camera_motion`이 **한 행도 없으면 조용히 아무것도 하지 않는다.** 현장 감시자가 아직 안
 * 붙은 상태가 그것인데, 그걸 오류로 다루면 퇴실마다 시스템 오류가 쌓인다 — CCTV 설정이 없을 때
 * 카메라 보고를 조용히 건너뛰는 `cameras.js`와 같은 태도다.
 */
export async function checkCheckoutOverdue(
  sb: SupabaseClient,
  reservations: ReservationWindow[],
  now: Date,
): Promise<number> {
  if (!isSweeping(reservations, now)) return 0;

  const elapsed = sweepElapsedMinutes(reservations, now);
  if (elapsed === null) return 0;

  const { lookFrom, since } = overdueWindow(elapsed, now);
  // 유예 안이면 아직 볼 때가 아니다. 나가는 중인 손님을 붙잡지 않으려는 창이다.
  if (now < lookFrom) return 0;

  const motions = await loadMotions(sb);
  if (!motions.length) return 0; // 감시자 미설치 — 조용히 건너뛴다

  const { moved, unknown, latest } = decideOverdue(motions, lookFrom, now);

  // 관측이 낡은 카메라는 **알림과 별개로** 남긴다. 창당 1회 억제에 걸리면 안 되는 신호다 —
  // '사람이 있다'와 '판단할 수 없다'는 사람이 할 일이 다르다. 재알림 간격은
  // `recordSystemError`의 15분 backoff가 알아서 잡는다.
  if (unknown.length) {
    await recordSystemError(
      sb,
      "motion_watch_stale",
      `카메라 ${unknown.length}대의 움직임 관측이 ${MOTION_STALE_SECONDS}초 넘게 갱신되지 않아 ` +
        `퇴실 후 재실 여부를 판단하지 못했습니다`,
      now,
    );
  }

  if (!moved.length) return 0;

  // 이번 창에서 이미 알렸으면 끝. 장부가 판단 근거인 이유는 `fetchActedDevices`의 주석과 같다 —
  // 관측값은 낡지만 장부는 낡지 않는다.
  //
  // ⚠️ 알려진 한계: 이 조회와 아래 기록 사이가 원자적이지 않다. `automate`는 anon으로 누구나
  // 부를 수 있어(claimPending 주석 참조) 크론 틱과 수동 호출이 수 초 안에 겹치면 같은 창에서
  // 두 번 알릴 수 있다. 대가가 중복 알림 1건뿐이라 유니크 제약(스키마 변경)의 비용을 치르지
  // 않는다 — 스윕의 창당 1회 억제(enforce.ts)와 같은 태도다.
  if (await fetchLatestByAction(sb, "checkout_overdue", "observed", since)) return 0;

  const minutes = Math.floor(elapsed);
  await recordMany(
    sb,
    moved.map((camera_id) => ({
      device_id: null,
      camera_id,
      kind: "checkout_overdue" as const,
      action: "observed",
      value: `퇴실 시각에서 ${minutes}분 지났는데 움직임이 관측됐습니다`,
      status: "ok" as const,
    })),
  );
  console.warn(`퇴실 독려 — 퇴실 ${minutes}분 경과, 카메라 ${moved.length}대에서 움직임`, latest?.toISOString());
  return moved.length;
}
