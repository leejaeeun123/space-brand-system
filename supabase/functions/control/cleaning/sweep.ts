/**
 * 청소 안내 스윕 — 매 틱 한 번, 지금 나갈 것을 내보낸다.
 *
 * 판정(`schedule.ts`·`windows.ts`·`diff.ts`)과 발송(`dispatch.ts`)을 이어 붙이기만 한다.
 * 손님 문자의 `sms/sweep.ts`가 하는 역할과 같은 자리다.
 *
 * **여기서 예외가 밖으로 나가면 안 된다** — 호출부가 try/catch로 감싸지만, 한 단계 안에서
 * 끝낼 수 있는 것은 여기서 끝낸다. 무인 운영에서 조용한 실패는 실패가 아니라 사고다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { kstDay } from "../automation/windows.ts";
import { loadConfig, normalizePhone } from "../sms/solapi.ts";
import { buildSnapshot, compare, fingerprint, isEmpty } from "./diff.ts";
import { digestSent, dispatch, latestSnapshot, markQuiet, type Outgoing } from "./dispatch.ts";
import { digestState, updateAllowed } from "./schedule.ts";
import { digestMessage, updateMessage } from "./templates.ts";
import { type CleaningReservation, nextDayFirstPrep, planCleaning, remaining, todayReservations } from "./windows.ts";

export interface CleaningSweepResult {
  digest: number;
  update: number;
  /** 문자 없이 채널에만 남긴 것(22시 이후). */
  quiet: number;
  failed: number;
}

const EMPTY: CleaningSweepResult = { digest: 0, update: 0, quiet: 0, failed: 0 };

/**
 * 수신자. **DB가 아니라 시크릿에 둔다** — 담당자가 1명이고 거의 안 바뀌는데, 남의 개인
 * 연락처라 이 레포는 ThinQ PAT·service_role 키와 같은 급으로 다룬다.
 */
function recipient(): string | null {
  return normalizePhone(Deno.env.get("CLEANING_SMS_TO") ?? "");
}

/**
 * 오늘 몫을 훑는다.
 *
 * 설정이 없으면 **아무것도 적지 않고** 콘솔에만 남긴다. 장부에 실패로 쌓으면 설정을 넣었을 때
 * 이미 자리가 막혀 있고, 재시도 가능한 상태로 적으면 매 틱 같은 실패가 쌓인다. 설정 누락은
 * 예약의 문제가 아니라 서버의 문제다(`sms/sweep.ts`와 같은 판단).
 */
export async function sweepCleaning(
  sb: SupabaseClient,
  reservations: CleaningReservation[],
  now: Date,
): Promise<CleaningSweepResult> {
  const cfg = loadConfig();
  if (!cfg) {
    console.error("SOLAPI 미설정 — 청소 안내를 건너뛴다");
    return EMPTY;
  }
  const phone = recipient();
  if (!phone) {
    console.error("CLEANING_SMS_TO 미설정(또는 문자를 받을 수 없는 번호) — 청소 안내를 건너뛴다");
    return EMPTY;
  }

  const result: CleaningSweepResult = { ...EMPTY };
  const date = kstDay(now);
  const todays = todayReservations(reservations, now);
  const snapshot = buildSnapshot(todays, now);
  // 창은 스케줄 전체로 계산하고, 표시 직전에 '지금'으로 자른다. 순서를 바꾸면 오전에
  // 지나간 긴 창이 '10분짜리'로 보여 연달림 경고로 둔갑한다(`windows.ts` 주석).
  // 마지막 구간을 닫을 경계는 **오늘 몫으로 줄이기 전** 전체 목록에서 뽑는다 — 내일 예약은
  // `todayReservations`가 걸러내므로 그 전의 `reservations`를 봐야 보인다.
  const plan = remaining(planCleaning(todays, now, nextDayFirstPrep(reservations, now)), now);

  const state = digestState(now);
  if (state !== "wait") {
    const out: Outgoing = {
      kind: "digest",
      date,
      body: digestMessage(snapshot.entries, plan, now),
      snapshot,
      fingerprint: null,
    };
    if (state === "fire") {
      const sent = await dispatch(sb, cfg, phone, out);
      if (sent === "sent") result.digest++;
      else if (sent === "failed") result.failed++;
    } else if (await markQuiet(sb, out)) {
      result.quiet++;
    }
  }

  // 변경 안내는 다이제스트가 실제로 나간 뒤에만 의미가 있다 — 담당자가 아직 오늘 스케줄을
  // 본 적이 없으면 '변경'이라고 부를 기준선이 없다. 07:00 이전 변경은 다이제스트가 최신
  // 상태로 담으므로 따로 알릴 것이 없다.
  if (!await digestSent(sb, date)) return result;

  const baseline = await latestSnapshot(sb, date);
  if (!baseline) return result;

  const diff = compare(baseline, snapshot);
  if (isEmpty(diff)) return result;

  const out: Outgoing = {
    kind: "update",
    date,
    body: updateMessage(diff, plan, now),
    snapshot,
    fingerprint: await fingerprint(snapshot),
  };
  if (updateAllowed(now)) {
    const sent = await dispatch(sb, cfg, phone, out);
    if (sent === "sent") result.update++;
    else if (sent === "failed") result.failed++;
  } else if (await markQuiet(sb, out)) {
    result.quiet++;
  }

  return result;
}
