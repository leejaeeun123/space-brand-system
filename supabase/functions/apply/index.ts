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
 *
 * **부르는 쪽이 둘이다.** 접수(`submit`)는 공개고, 선정·보류(`decide`·`preview`·`mark_manual`)는
 * 어드민 전용이다 — 후자는 손님에게 문자를 보내는 일이라 아무나 부르면 안 된다.
 * 판정은 `isAdmin` 하나에 있고, `claim`과 같은 방식이다.
 */

import { validate } from "./validate.ts";
import { dbClient, insert, markNotified } from "./store.ts";
import { notify } from "./notify.ts";
import { decide } from "./decide.ts";
import { markManual } from "./dispatch.ts";
import { APPLICATION_SMS_KINDS, type ApplicationSmsKind, render } from "./templates.ts";
import { HandlerError } from "./errors.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { constantTimeEqual } from "../_shared/secret.ts";
import {
  clientIp,
  isThrottled,
  recordFailure,
  THROTTLED_MESSAGE,
} from "../_shared/throttle.ts";

type Json = (body: unknown, status?: number) => Response;

/**
 * 응답 헬퍼를 요청마다 만든다.
 *
 * CORS 헤더가 요청의 오리진에 따라 달라져서다(`_shared/cors.ts`의 화이트리스트).
 * 모듈 수준 상수로 두면 동시에 들어온 요청이 서로의 오리진을 물려받는다.
 */
function makeJson(req: Request): Json {
  const cors = corsHeaders(req);
  return (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
}

/**
 * 어드민인가. **미설정이면 전면 거부**다(`claim/index.ts`·`control/auth.ts`와 같은 태도) —
 * 비밀번호가 없는 상태가 '누구나 손님에게 문자를 보낼 수 있다'로 해석되면 안 된다.
 */
function isAdmin(supplied: string): boolean {
  const admin = Deno.env.get("ADMIN_PASSWORD");
  if (!admin) {
    console.error("ADMIN_PASSWORD 미설정 — 어드민 요청을 거부합니다");
    throw new HandlerError(503, "서버 설정이 완료되지 않았습니다");
  }
  return supplied !== "" && constantTimeEqual(supplied, admin);
}

function parseKind(body: Record<string, unknown>): ApplicationSmsKind {
  const kind = String(body.decision ?? body.kind ?? "");
  if (!APPLICATION_SMS_KINDS.includes(kind as ApplicationSmsKind)) {
    throw new HandlerError(400, `알 수 없는 결과: ${kind}`);
  }
  return kind as ApplicationSmsKind;
}

/** 접수 — 공개 경로. 이 함수의 원래 일이다. */
async function submit(body: Record<string, unknown>, json: Json): Promise<Response> {
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
}

Deno.serve(async (req) => {
  const json = makeJson(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json({ error: "POST만 허용합니다" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON 본문이 필요합니다" }, 400);
  }

  // action이 없으면 접수다 — 기존 `apply.html`이 action 없이 부르고 있어 그 계약을 지킨다.
  const action = String(body.action ?? "submit");

  try {
    if (action === "submit") return await submit(body, json);

    // ── 여기부터 어드민 전용. 손님에게 문자를 보내는 일이라 아무나 부르면 안 된다. ──
    //
    // 비밀번호를 던져볼 수 있는 횟수 자체를 자른다. 세 함수가 같은 `ADMIN_PASSWORD`를
    // 검증하므로 카운터도 하나여야 한다 — 한 곳만 조이면 안 조인 표면으로 옮겨가면 그만이다.
    // 공개 접수(`submit`)는 이 위에서 이미 끝났으므로 신청자는 영향받지 않는다.
    const supplied = String(body.password ?? "");
    const ip = clientIp(req);
    const sbAuth = dbClient();
    if (await isThrottled(sbAuth, ip)) {
      return json({ error: THROTTLED_MESSAGE }, 429);
    }
    if (!isAdmin(supplied)) {
      await recordFailure(sbAuth, ip, "apply");
      return json({ error: "invalid password" }, 401);
    }

    // 미리보기는 DB를 건드리지 않는다 — 문구만 만들어 돌려준다.
    // 어드민이 이걸 보고 승인해야 발송되므로, **문구를 만드는 곳이 서버 한 곳**이라는 점이
    // 미리보기와 실제 발송이 같다는 유일한 보장이다.
    if (action === "preview") return json({ body: render(parseKind(body)) });

    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "id가 필요합니다" }, 400);

    const sb = dbClient();
    const memo = String(body.memo ?? "").trim().slice(0, 500);

    switch (action) {
      case "decide":
        return json(await decide(sb, id, parseKind(body), memo));

      case "mark_manual": {
        // 문자가 못 나간 건을 사람이 직접 보낸 뒤 장부를 닫는다.
        const { data, error } = await sb
          .from("support_applications")
          .select("id,name,phone")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(`신청 조회 실패: ${error.message}`);
        if (!data) throw new HandlerError(404, "해당 신청을 찾을 수 없습니다");
        await markManual(sb, data, parseKind(body));
        return json({ ok: true });
      }

      default:
        return json({ error: `알 수 없는 action: ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof HandlerError) return json({ error: e.message }, e.status);
    console.error("apply 처리 실패", e);
    return json({ error: "처리 중 오류가 발생했습니다" }, 500);
  }
});
