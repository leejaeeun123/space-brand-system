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

/**
 * 워치독이 쓸 웹훅 주소를 Edge Function 시크릿에서 DB로 옮겨 놓는다.
 *
 * **왜 옮겨야 하나.** 감시 잡은 순수 SQL(pg_cron + pg_net)이라 Edge Function 시크릿을 못 읽는다.
 * 그런데 그게 이 설계의 핵심이다 — 감시 주체가 Edge Function 안에 있으면 그 함수가 통째로
 * 죽는 실패를 원리상 못 본다(#44·#70). 그래서 URL만 DB로 내려보낸다.
 *
 * **왜 사람이 손으로 넣지 않나.** 그러면 누군가 평문 URL을 복사해 SQL 편집기에 붙여야 하고,
 * 그 값은 편집기 기록에 남는다. 게다가 나중에 Mattermost 웹훅을 교체하면 두 곳이 조용히
 * 어긋나 — 시크릿은 새 주소, 워치독은 옛 주소 — 정작 알림이 필요한 날 아무 데도 안 간다.
 * 매 틱 대조하면 시크릿 한 곳만 고쳐도 따라온다.
 *
 * 시크릿이 비어 있으면 **아무것도 쓰지 않는다.** 빈 값을 넣으면 워치독이 '설정됨'으로 보고
 * 빈 주소로 POST를 시도한다 — 설정 안 된 상태는 조용해야지 오작동이면 안 된다.
 *
 * 실패해도 던지지 않는다. 이건 부가 설정이지 자동화의 조건이 아니다.
 */
export async function syncWatchdogWebhook(
  sb: SupabaseClient,
): Promise<"set" | "unchanged" | "missing" | "failed"> {
  const url = Deno.env.get("MATTERMOST_WEBHOOK_URL") ?? "";
  if (url === "") return "missing";

  const { data, error } = await sb
    .from("automation_config")
    .select("value")
    .eq("key", "heartbeat_webhook_url")
    .maybeSingle();
  if (error) {
    console.warn("워치독 웹훅 조회 실패", error.message);
    return "failed";
  }
  // 같으면 쓰지 않는다 — 매 틱 같은 값을 다시 쓸 이유가 없다.
  if (data?.value === url) return "unchanged";

  const { error: upsertError } = await sb
    .from("automation_config")
    .upsert({ key: "heartbeat_webhook_url", value: url });
  if (upsertError) {
    console.warn("워치독 웹훅 저장 실패", upsertError.message);
    return "failed";
  }
  return "set";
}
