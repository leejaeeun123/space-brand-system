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
 */

import { dbClient } from "./devices.ts";
import { HandlerError } from "./handlers/shared.ts";
import { list } from "./handlers/list.ts";
import { command } from "./handlers/command.ts";
import { registerLight, registerThinq, remove, thinqDevices } from "./handlers/registry.ts";
import {
  cameraCredentials,
  cameras,
  registerCamera,
  removeCamera,
} from "./handlers/cameras.ts";

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

  const expected = Deno.env.get("ADMIN_PASSWORD");
  if (!expected) {
    // 비밀번호가 설정 안 된 상태로 열어두면 무인증 제어가 된다. 열지 않는다.
    console.error("ADMIN_PASSWORD 미설정 — 모든 요청을 거부합니다");
    return json({ error: "서버 설정이 완료되지 않았습니다" }, 503);
  }
  if (String(body.password ?? "") !== expected) {
    return json({ error: "invalid password" }, 401);
  }

  const sb = dbClient();
  try {
    switch (String(body.action ?? "")) {
      // ── 기기 제어 ──

      case "list":
        return json(await list(sb));
      case "thinq_devices":
        return json(await thinqDevices());
      case "register":
        return json(await registerThinq(sb, body));
      case "register_light":
        return json(await registerLight(sb, body));
      case "command":
        return json(await command(sb, body));
      case "delete":
        return json(await remove(sb, body));

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
        return json({ error: `알 수 없는 action: ${body.action}` }, 400);
    }
  } catch (e) {
    if (e instanceof HandlerError) return json({ error: e.message }, e.status);
    console.error("control 처리 실패", e);
    return json({ error: "처리 중 오류가 발생했습니다" }, 500);
  }
});
