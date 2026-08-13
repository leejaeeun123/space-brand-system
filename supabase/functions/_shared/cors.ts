/**
 * CORS — 어느 사이트가 이 함수의 응답을 **읽을 수 있나**.
 *
 * 세 함수 모두 `Access-Control-Allow-Origin: *`였다. 그러면 아무 웹페이지나 방문자의
 * 브라우저와 IP를 빌려 이 시스템을 부르고 응답까지 읽을 수 있다. 실제로 문제가 되는 것은
 * 두 가지다 — 비밀번호 대입을 방문자별로 분산시켜 IP 기반 제한을 우회하는 것, 그리고
 * 예약 시간 중이면 임의 사이트가 남의 브라우저로 조명·냉난방을 조작하는 것
 * (손님 시간창은 '지금 예약이 진행 중인가'만 보지 호출자가 그 예약자인지는 안 본다).
 *
 * **이건 방어의 전부가 아니라 한 겹이다.** CORS는 브라우저만 지킨다 — curl이나 서버에서
 * 부르는 요청에는 아무 영향이 없다. 실제 권한은 여전히 `auth.ts`가 자른다. 여기서 막는 것은
 * "남의 브라우저를 빌리는 것"뿐이고, 그게 정확히 대입 분산과 CSRF성 조작의 전제다.
 *
 * 목록에 없는 오리진에는 정본 오리진을 돌려준다 — 그러면 브라우저가 응답 판독을 막는다.
 * (헤더를 아예 빼면 일부 브라우저가 다른 방식으로 처리해 결과가 갈린다.)
 */

/** 이 시스템의 페이지가 실제로 올라가는 곳. */
const CANONICAL_ORIGIN = "https://typelounge.vercel.app";

/**
 * 허용 오리진.
 *
 * Vercel 프리뷰 배포(`*.vercel.app`의 임의 서브도메인)는 **일부러 안 넣었다** — 넣으면
 * 누구나 자기 Vercel 프로젝트를 그 패턴에 맞춰 올려 화이트리스트를 통과한다.
 * 프리뷰에서 시험할 일이 생기면 그때 정확한 호스트를 여기 한 줄 추가한다.
 */
const ALLOWED_ORIGINS = new Set([
  CANONICAL_ORIGIN,
]);

/**
 * 이 요청에 돌려줄 CORS 헤더.
 *
 * `Vary: Origin`이 필수다 — 없으면 CDN·브라우저 캐시가 한 오리진에 준 응답을 다른
 * 오리진에도 그대로 내주어 화이트리스트가 조용히 무의미해진다.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : CANONICAL_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
