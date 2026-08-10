/**
 * 공간 지원 프로그램 신청 접수 Edge Function — HTTP 표면만: CORS·검증 호출·순서·직렬화.
 *
 * **`control`과 합치지 않은 이유가 설계의 핵심이다.** 저기서 비밀번호를 안 보낸 요청은 `guest`고,
 * guest의 모든 action은 **예약 시간 안에서만** 열린다(`control/reservation-window.ts`). 신청은
 * 아무 때나 들어와야 하므로 그 규칙에 예외를 뚫어야 하는데, 그 규칙은 손님이 남의 이용 중에
 * 기기를 못 건드리게 막는 장치라 예외를 하나 내는 순간 읽는 사람마다 다르게 이해하기 시작한다.
 * 제어와 접수는 등급이 다른 일이므로 표면을 따로 둔다.
 *
 * 이 함수도 **서버에 있어야 한다.** `apply.html`은 소스가 공개되므로, 브라우저가 직접 DB에
 * 쓰게 하려면 anon 키에 insert 정책을 열어야 하고 그 순간 검증도 스팸 필터도 우회된다.
 *
 * **순서가 계약이다 — 저장 먼저, 알림 나중.** 뒤집으면 웹훅이 죽어 있던 동안의 신청이 통째로
 * 사라지고, 신청자는 보냈다고 믿는다. 알림은 못 가도 되고(장부에 null로 남는다), 저장은 못 하면
 * 실패로 답해야 한다.
 */

import { validate } from "./validate.ts";
import { dbClient, insert, markNotified } from "./store.ts";
import { notify } from "./notify.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST만 허용합니다" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON 본문이 필요합니다" }, 400);
  }

  const parsed = validate(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  // 스팸은 **성공으로 답한다.** 400을 주면 보낸 쪽이 덫의 존재를 알아채고 다음엔 피해 간다.
  if ("spam" in parsed) {
    console.warn("스팸으로 판정한 신청을 버린다");
    return json({ ok: true });
  }

  const at = new Date();
  const sb = dbClient();

  let id: number;
  try {
    id = await insert(sb, parsed.value, at);
  } catch (e) {
    console.error("신청 접수 실패", e);
    return json({ error: "접수 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요." }, 500);
  }

  // 여기부터는 실패해도 신청자에게 성공으로 답한다 — 이미 접수됐기 때문이다.
  if (await notify(parsed.value, at)) await markNotified(sb, id, at);

  return json({ ok: true });
});
