/**
 * 어드민 비밀번호 대입 시도 제한 — 세 함수(control·claim·apply)가 같은 판정을 쓴다.
 *
 * **왜 공유 모듈인가**: 이 셋은 같은 `ADMIN_PASSWORD` 하나를 검증한다. 한 곳만 조이면
 * 공격자는 조이지 않은 표면으로 옮겨가 같은 값을 계속 던진다. 그래서 카운터도 하나여야
 * 하고(`auth_attempts` 한 테이블), 판정 코드도 하나여야 한다.
 *
 * **무엇을 세는가 — 실패한 인증 시도뿐이다.** 성공은 안 센다(정상 사용자가 자기 문을
 * 잠근다). 비밀번호를 아예 안 보낸 요청도 안 센다 — pg_cron이 1분마다 부르는 `automate`가
 * 정확히 그런 요청이라, 그걸 세면 자동화가 스스로 문을 잠그고 무인 공간이 조용히 죽는다.
 * (#44·#70에서 자동화 침묵이 실제로 두 번 일어났다. 그 실패 모드를 여기서 다시 만들지 않는다.)
 *
 * **DB가 안 되면 통과시킨다(fail-open).** 판정 테이블을 못 읽는 상황에서 잠그면, DB 장애가
 * 곧 "어드민이 현장에 못 들어가고 자동화도 멈춤"이 된다. 무인 공간에서 그 대가는 대입 공격의
 * 기대 피해보다 크다 — 공격자가 이 조회를 실패시킬 수단도 없다. 대신 반드시 로그를 남긴다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** 판정 창. 이 시간 안의 실패만 센다. */
const WINDOW_MS = 10 * 60_000;

/**
 * 창 안에서 허용하는 최대 실패 횟수.
 *
 * 사람이 비밀번호를 잘못 치는 것은 10분에 몇 번이지 열 번이 아니다. 반대로 대입 공격에는
 * 10분에 10회가 의미 있는 상한이다 — 숫자 10자리 키스페이스를 이 속도로 훑으면 수천 년이 걸린다.
 */
const MAX_FAILS = 10;

/** 어느 함수에서 실패했는지. 한 IP가 여러 표면을 훑는 것을 나중에 구분하려고 남긴다. */
export type AuthSurface = "control" | "claim" | "apply";

/**
 * 요청자 IP. Edge Function 앞단이 붙이는 `x-forwarded-for`의 **첫 항목**이 원 클라이언트다.
 *
 * 헤더가 없으면 빈 문자열을 돌려주고, 호출부는 그 값으로도 정상 동작한다 — 모든 헤더 없는
 * 요청이 한 바구니에 담겨 함께 제한될 뿐이라 오히려 보수적이다.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0].trim();
}

/**
 * 이 IP가 이미 상한을 넘었나. 넘었으면 `true`.
 *
 * 호출부는 **비밀번호를 검증하기 전에** 이걸 물어야 한다 — 검증 후에 물으면 이미 한 번 더
 * 던져본 뒤다.
 */
export async function isThrottled(sb: SupabaseClient, ip: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count, error } = await sb
    .from("auth_attempts")
    .select("*", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("at", since);

  if (error) {
    // fail-open. 무슨 일이 있었는지는 남긴다 — 이게 조용하면 방어가 사라진 것도 조용해진다.
    console.error(`auth_attempts 조회 실패 — 시도 제한을 건너뜁니다: ${error.message}`);
    return false;
  }
  return (count ?? 0) >= MAX_FAILS;
}

/**
 * 실패 한 건을 기록한다. **인증에 실패했을 때만** 부른다.
 *
 * 기록에 실패해도 요청 처리를 막지 않는다 — 이건 부가 장치이지 인증 자체가 아니다.
 */
export async function recordFailure(
  sb: SupabaseClient,
  ip: string,
  fn: AuthSurface,
): Promise<void> {
  const { error } = await sb.from("auth_attempts").insert({ ip, fn });
  if (error) console.error(`auth_attempts 기록 실패 (${fn}): ${error.message}`);
}

/** 차단됐을 때 손님·어드민에게 보이는 문구. 남은 시간을 알려줘야 다시 안 두드린다. */
export const THROTTLED_MESSAGE =
  "비밀번호 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요.";
