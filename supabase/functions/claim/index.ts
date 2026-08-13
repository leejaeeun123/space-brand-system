/**
 * 지원금(페이백) 신청 Edge Function — HTTP 표면만: CORS·역할 판정·라우팅·직렬화.
 *
 * **부르는 쪽이 둘이고 등급이 다르다.**
 *  · `submit` — 공개 신청 페이지(`payback.html`). 비밀번호 없음.
 *  · `reveal`·`mark_paid`·`reject` — 어드민(`admin.html`). ADMIN_PASSWORD 필요.
 *
 * `apply`와 합치지 않은 이유: 저기는 **공개 액션 하나뿐**이라 인증이라는 개념 자체가 없다.
 * 여기에 어드민 전용 복호화를 얹으면, 실수 하나가 공개 경로에서 주민번호를 여는 사고가 된다.
 * 비밀을 여는 함수와 아무나 부르는 함수를 한 파일에 두지 않는 것이 이 분리의 전부다.
 *
 * `control`에 넣지 않은 이유도 같다 — 거기 guest 경로는 예약 시간 안에서만 열리는데,
 * 지원금 신청은 아무 때나 들어와야 한다(`apply`와 같은 사정).
 *
 * **순서가 계약이다 — 저장 먼저, 알림 나중.** 뒤집으면 웹훅이 죽어 있던 동안의 신청이
 * 사라지고, 신청자는 보냈다고 믿는다.
 */

import { validate } from "./validate.ts";
import { dbClient, insert, markNotified, markPaid, reject, reveal } from "./store.ts";
import { notify } from "./notify.ts";
import { HandlerError } from "./errors.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { constantTimeEqual } from "../_shared/secret.ts";
import {
  clientIp,
  isThrottled,
  recordFailure,
  THROTTLED_MESSAGE,
} from "../_shared/throttle.ts";

/**
 * 어드민인가. **미설정이면 전면 거부**다(auth.ts와 같은 태도) — 비밀번호가 없는 상태가
 * '누구나 주민번호를 열 수 있다'로 해석되면 안 된다.
 */
function isAdmin(supplied: string): boolean {
  const admin = Deno.env.get("ADMIN_PASSWORD");
  if (!admin) {
    console.error("ADMIN_PASSWORD 미설정 — 어드민 요청을 거부합니다");
    throw new HandlerError(503, "서버 설정이 완료되지 않았습니다");
  }
  return supplied !== "" && constantTimeEqual(supplied, admin);
}

Deno.serve(async (req) => {
  // 헤더는 요청의 오리진에 따라 달라진다 — 모듈 상수로 두면 동시 요청이 서로의 것을 물려받는다.
  const cors = corsHeaders(req);
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST만 허용합니다" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON 본문이 필요합니다" }, 400);
  }

  const action = String(body.action ?? "submit");
  const sb = dbClient();

  try {
    // ── 공개: 접수 ──
    if (action === "submit") {
      const parsed = validate(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      if ("spam" in parsed) {
        console.warn("스팸으로 판정한 지원금 신청을 버립니다");
        return json({ ok: true });
      }

      const at = new Date();
      let id: number;
      try {
        id = await insert(sb, parsed.value, at);
      } catch (e) {
        // 키 미설정(503)은 그대로 올려보낸다 — 400으로 뭉개면 신청자가 자기 입력을 고치려 든다.
        if (e instanceof HandlerError) throw e;
        console.error("지원금 신청 접수 실패", e);
        return json({ error: "접수 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요." }, 500);
      }

      if (await notify(parsed.value, at)) await markNotified(sb, id, at);
      return json({ ok: true });
    }

    // ── 여기부터 어드민 전용 ──
    //
    // 이 문 뒤에 있는 것이 `reveal` — 주민번호·계좌를 평문으로 꺼내는 유일한 경로다.
    // 그래서 비밀번호를 던져볼 수 있는 횟수 자체를 자른다(공개 접수 경로는 이 위에서 이미 끝났으므로
    // 신청자는 영향받지 않는다).
    const supplied = String(body.password ?? "");
    const ip = clientIp(req);
    if (await isThrottled(sb, ip)) {
      return json({ error: THROTTLED_MESSAGE }, 429);
    }
    if (!isAdmin(supplied)) {
      await recordFailure(sb, ip, "claim");
      return json({ error: "invalid password" }, 401);
    }

    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "id가 필요합니다" }, 400);
    const memo = String(body.memo ?? "").trim().slice(0, 500);

    switch (action) {
      case "reveal": {
        // 복호화 결과는 응답으로만 나간다 — 로그에 찍지 않는다(store.ts 주석 참조).
        const revealed = await reveal(sb, id);
        // **연 사실은 남긴다.** 열람 자체가 기록되지 않으면, 사고가 났을 때 무엇이 샜는지
        // 확정할 수단이 없다. 값이 아니라 '언제 누가 어느 건을' 만 남긴다(마이그레이션 주석).
        // 기록에 실패해도 응답은 준다 — 이건 부가 장치이지 열람의 조건이 아니다.
        const { error } = await sb.from("payback_reveal_log").insert({ claim_id: id, ip });
        if (error) console.error(`접속기록 저장 실패 (id=${id}): ${error.message}`);
        return json(revealed);
      }

      case "mark_paid":
        await markPaid(sb, id, new Date(), memo);
        return json({ ok: true });

      case "reject":
        // 암호문을 그 자리에서 지운다. 지급하지 않으면 주민번호를 들고 있을 근거가 없다.
        await reject(sb, id, new Date(), memo);
        return json({ ok: true });

      default:
        return json({ error: `알 수 없는 action: ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof HandlerError) return json({ error: e.message }, e.status);
    console.error("claim 처리 실패", e);
    return json({ error: "처리 중 오류가 발생했습니다" }, 500);
  }
});
