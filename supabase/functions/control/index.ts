/**
 * 공간 제어 Edge Function — HTTP 표면만: CORS·인증·라우팅·직렬화.
 * 실제 동작은 handlers/가 갖는다.
 *
 * **이 함수가 존재하는 이유**는 편의가 아니라 필수다. ThinQ PAT와 service_role 키는
 * 절대 브라우저에 내려가면 안 되는데, admin.html은 소스가 그대로 공개된다.
 * 그래서 비밀을 들고 있는 층이 서버에 하나 필요하고, 그게 여기다.
 *
 * 인증: admin.html이 이미 쓰는 비밀번호를 그대로 받되, 정답은 **환경변수**에서 읽는다.
 * reservations 쪽 admin_* RPC처럼 SQL 함수 안에 평문으로 박아두는 방식을 답습하지 않는다 —
 * 그러면 같은 비밀이 repo 안에서 하나 더 늘어난다.
 *
 * 부르는 쪽이 둘이다 — 어드민(`admin.html`)과 **손님 페이지(`guest-control.html`)**. 둘은
 * 비밀번호가 다르고 할 수 있는 일도 다르다. 그 판정은 전부 `auth.ts`에 있다.
 */

import { dbClient } from "./devices.ts";
import { assertAllowed, resolveRole, scrubDevices, type Role } from "./auth.ts";
import { type GuideGate, guideGate, withinReservationWindow } from "./reservation-window.ts";
import { HandlerError } from "./handlers/shared.ts";
import { guide } from "./handlers/guide.ts";
import { list } from "./handlers/list.ts";
import { issue } from "./automation/dispatch.ts";
import { automate } from "./handlers/automation.ts";
import { registerLight, registerThinq, remove, thinqDevices } from "./handlers/registry.ts";
import {
  cameraCredentials,
  cameras,
  registerCamera,
  removeCamera,
} from "./handlers/cameras.ts";
import { markManualSent, preview, sendOne, setAuto } from "./handlers/sms.ts";
import { complete, pending } from "./handlers/cleaning.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  clientIp,
  isThrottled,
  recordFailure,
  THROTTLED_MESSAGE,
} from "../_shared/throttle.ts";

Deno.serve(async (req) => {
  // 응답 헤더는 요청마다 달라진다(오리진 화이트리스트). 그래서 핸들러 안에서 묶는다 —
  // 모듈 수준 상수로 두면 동시 요청이 서로의 오리진을 물려받는다.
  const cors = corsHeaders(req);
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json", ...extra },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST만 허용합니다" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON 본문이 필요합니다" }, 400);
  }

  const sb = dbClient();

  // 비밀번호가 설정 안 된 상태로 열어두면 무인증 제어가 된다. 열지 않는다(auth.ts).
  // `token`은 현장 QR 전용 자격증명이다 — 비밀번호와 겸용하지 않는다(auth.ts 참고).
  //
  // **자격증명을 뭐라도 보낸 요청만 시도 제한을 탄다.** 아무것도 안 보낸 요청은 손님이거나
  // pg_cron의 `automate`이고, 그걸 세면 1분마다 오는 자동화가 스스로 문을 잠근다
  // (#44·#70에서 자동화 침묵이 실제로 두 번 일어났다 — 그 실패 모드를 다시 만들지 않는다).
  const supplied = String(body.password ?? "");
  const suppliedToken = String(body.token ?? "");
  const guessing = supplied !== "" || suppliedToken !== "";
  const ip = clientIp(req);

  let role: Role;
  try {
    if (guessing && await isThrottled(sb, ip)) {
      return json({ error: THROTTLED_MESSAGE }, 429);
    }
    const resolved = resolveRole(supplied, suppliedToken);
    if (!resolved) {
      await recordFailure(sb, ip, "control");
      return json({ error: "invalid password" }, 401);
    }
    role = resolved;
  } catch (e) {
    if (e instanceof HandlerError) return json({ error: e.message }, e.status);
    throw e;
  }

  const action = String(body.action ?? "");
  try {
    // 손님이 할 수 있는 일은 여기서 잘린다. 클라이언트에서 버튼을 감추는 것으로는 부족하다.
    assertAllowed(role, action, body);

    // 손님 페이지는 예약 시간에만 연다 — URL만 알면 누구나 부를 수 있어 "언제"도 서버가
    // 정한다(reservation-window.ts). admin은 예약 시간과 무관하게 늘 열려 있다.
    // code는 guest-control.html이 "일반 오류"와 "지금은 예약 시간이 아님"을 구분해
    // 안내 문구를 바꾸는 데 쓴다 — 메시지 문자열 비교는 문구가 바뀌면 조용히 깨진다.
    //
    // ⚠️ **`automate`는 이 게이트를 거치지 않는다.** 이 action이 일해야 하는 순간은 전부
    // 예약 구간 **밖**이다 — 입실 15분 전 준비, 그보다 앞선 안내 문자, 퇴실 시각 전원 끄기,
    // 퇴실 후 10분 스윕. 게이트를 통과하는 시간대에는 할 일이 없고, 할 일이 있는 시간대에는
    // 통과를 못 한다. 2026-08-09(#44)에 이 게이트가 들어오면서 자동화가 통째로 죽었고,
    // pg_cron은 매분 403만 받았다 — cron 실행은 '성공'으로 남아 침묵으로 보였다.
    // 여기서 여는 것이 안전한 이유는 auth.ts에 이미 적혀 있다: 대상 예약을 호출자가 고르지
    // 못하고 서버가 지금 시각으로 직접 계산한다(형운 결정, 2026-08-07).
    //
    // **`guide`만 게이트가 10분 이르다.** 이용 안내 페이지는 손님이 문 앞에서 현관 비밀번호를
    // 읽는 화면이라 입실 전에 열려야 하고, 그 리드타임은 입실 안내 문자 시각(`checkinNoticeAt`)
    // 에서 나온다 — reservation-window.ts 참고. 기기 제어는 그대로 시작 정각부터다: 리드타임은
    // 앞 손님의 마지막 10분일 수 있어, 그때 제어를 열면 다음 손님이 앞 손님 방의 조명을 만질 수
    // 있다. 같은 이유로 **현관 비밀번호도 그 겹침 동안은 응답에서 빠진다** — 판정(`GuideGate`)을
    // 여기서 받아 handlers/guide.ts에 넘긴다. 어드민 호출은 게이트를 안 거치므로 항상 전부 받는다.
    let gate: GuideGate | null = null;
    if (role === "guest" && action !== "automate") {
      let open: boolean;
      if (action === "guide") {
        gate = await guideGate(sb);
        open = gate.open;
      } else {
        open = await withinReservationWindow(sb);
      }
      if (!open) {
        return json({ error: "지금은 예약 시간이 아니에요", code: "outside_reservation_window" }, 403);
      }
    }

    switch (action) {
      // ── 기기 제어 ──

      case "list":
        return json(scrubDevices(role, await list(sb)));
      case "thinq_devices":
        return json(await thinqDevices());
      case "register":
        return json(await registerThinq(sb, body));
      case "register_light":
        return json(await registerLight(sb, body));
      case "command":
        // 사람이 원격에서 누른 것. 역할이 그대로 알림의 출처가 된다 — 어드민이 누른 것과
        // 손님이 누른 것은 읽는 사람에게 전혀 다른 정보다.
        return json(await issue(sb, body, role === "admin" ? "remote_admin" : "remote_guest"));
      case "delete":
        return json(await remove(sb, body));
      case "automate":
        return json(await automate(sb));

      // ── 이용 안내 페이지. 게이트를 통과했다는 것 자체가 응답이다(handlers/guide.ts).
      //    비밀번호가 실리는 응답이라 중간 캐시에 남지 않게 no-store를 명시한다 —
      //    POST라 실제로 캐시될 가능성은 낮지만, 값의 성격상 기본값에 기대지 않는다. ──
      case "guide":
        return json(guide(gate), 200, { "Cache-Control": "no-store" });

      // ── 손님 안내 문자. 전부 admin 전용이다(GUEST_ACTIONS에 없다).
      //    미리보기까지 막는 이유는 문구에 예약 일시가 들어가서다 — 그건 곧 언제 이 공간이
      //    비는가라는 정보다. ──
      case "sms_preview":
        return json(await preview(sb, body));
      case "sms_send":
        return json(await sendOne(sb, body));
      case "sms_mark_manual":
        return json(await markManualSent(sb, body));
      case "sms_auto":
        return json(await setAuto(sb, body));

      // ── 현장 QR로 표시하는 청소 완료. cleaner 전용이지만 admin도 부를 수 있다.
      //    읽기(`cleaning_pending`)와 쓰기(`cleaning_complete`)를 나눈 것은 스캐너 앱·메신저가
      //    링크를 미리 열어보는 일이 있어서다 — 찍는 것만으로 장부가 바뀌면 안 된다. ──
      case "cleaning_pending":
        return json(await pending(sb));
      case "cleaning_complete":
        // 역할을 그대로 출처로 넘긴다 — 현장 QR로 찍은 것과 어드민이 누른 것은 나중에
        // 잘못된 완료 표시를 가려낼 때 전혀 다른 정보다(handlers/cleaning.ts).
        return json(await complete(sb, role === "admin" ? "admin" : "qr"));

      // ── CCTV. 영상은 여기를 지나가지 않는다 — 목록·자격증명만 다룬다. ──
      case "cameras":
        return json(await cameras(sb));
      case "camera_credentials":
        return json(cameraCredentials());
      case "camera_register":
        return json(await registerCamera(sb, body));
      case "camera_delete":
        return json(await removeCamera(sb, body));

      default:
        return json({ error: `알 수 없는 action: ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof HandlerError) return json({ error: e.message }, e.status);
    console.error("control 처리 실패", e);
    return json({ error: "처리 중 오류가 발생했습니다" }, 500);
  }
});
