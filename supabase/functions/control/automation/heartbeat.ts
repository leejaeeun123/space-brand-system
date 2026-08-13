/**
 * 자동화 생존 하트비트 — 단일 책임: automate가 한 바퀴 정상 완주했음을 DB에 남긴다.
 *
 * 이 값 자체는 알림을 보내지 않는다. **게이트 밖의 독립 pg_cron 잡**(마이그레이션
 * `20260813130000_automation_heartbeat.sql`)이 이 값이 낡았는지만 보고 Mattermost로 직접
 * 알린다. 왜 Edge Function 안에서 감시하지 않는가: automate 진입 자체가 막히는 회귀(#44·#70 —
 * 게이트가 automate 전에 403을 반환)가 실제로 두 번 배포됐고, 그때는 이 함수의 어떤 코드도
 * 실행되지 않아 스스로는 침묵을 감지할 수 없었다. pg_net은 비동기라 `cron.job_run_details`엔
 * '성공'만 남는다. 감시 주체가 automate와 같은 실행 경로에 있으면, 그 경로가 통째로 죽는
 * 실패 모드를 원리상 못 본다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * 한 바퀴 완주를 기록한다. `runAutomation`의 **정상 종료 직전**에만 부른다 — 초입이 던지면
 * 하트비트가 갱신되지 않은 채로 낡아 감시 잡이 정지를 알린다(그게 이 설계의 목적이다).
 *
 * `alerted_at`을 null로 되돌리는 것은 **재무장**이다 — 정지에서 회복하면 다음 정지가 즉시
 * 알림을 받게 한다. 감시 잡은 알린 뒤 `alerted_at`을 채워 55분간 억제하는데, 그 억제를 정상
 * 완주가 풀어준다.
 *
 * 실패해도 던지지 않는다 — 하트비트 기록이 실패했다고 이미 끝난 자동화를 실패로 만들지 않는다.
 * 다만 이 write가 지속 실패하면 감시 잡이 오탐하므로 로그에는 반드시 남긴다.
 */
export async function recordHeartbeat(sb: SupabaseClient, now: Date): Promise<void> {
  const { error } = await sb
    .from("automation_heartbeat")
    .update({ beat_at: now.toISOString(), alerted_at: null })
    .eq("id", 1);
  if (error) console.warn("하트비트 기록 실패 — 감시 잡이 오탐할 수 있다", error.message);
}
