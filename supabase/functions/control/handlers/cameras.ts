/**
 * CCTV 핸들러 — 단일 책임: 카메라 인벤토리 조회·등록·해제와 스트림 자격증명 전달.
 *
 * **이 함수는 영상을 만지지 않는다.** 브라우저가 합정 맥의 MediaMTX에 직접 붙고, 여기는
 * 그 주소와 자격증명을 (비밀번호를 통과한 사람에게만) 알려줄 뿐이다.
 *
 * ── 왜 자격증명을 그냥 내려주는가 ────────────────────────────────────────────────
 * 처음엔 요청마다 검증하는 방식(MediaMTX authMethod: http → 이 함수가 인증 서버)을 검토했다.
 * 폐기한 이유 두 가지. MediaMTX는 **HLS 플레이리스트와 세그먼트 매 요청마다** 인증을 걸고,
 * 그건 초당 4~5회다.
 *   1) 지연 — 그 하나하나에 합정 맥 → Supabase 왕복이 끼면 재생이 계속 덜컥거린다.
 *   2) 호출 수 — 시청 1시간당 약 1.6만 호출이라, 하루 한 시간씩만 봐도 월 48만으로
 *      무료 한도(50만)에 닿는다. (상시 시청 기준이 아니다 — 화면을 떠나면 스트림을 끊는다.)
 * 그래서 검증은 MediaMTX 내장 인증(authInternalUsers)에 맡기고, 여기서는 **전달만** 한다.
 *
 * 그 대가는 자격증명이 장기 유효하다는 것이다. 받아들이는 근거:
 *   - 이 계정은 read/playback 권한만 갖는다(publish 불가 — 가짜 영상으로 덮어쓸 수 없다).
 *   - 자격증명을 받으려면 이미 admin 비밀번호를 통과해야 한다. 즉 admin 비밀번호와 같은
 *     등급이지 새로운 약점이 아니다.
 *   - 유출 시 회수는 mediamtx.yml의 계정 + 이 함수의 시크릿 교체 두 곳이다(cctv-setup.md).
 *
 * 전달된 자격증명은 **Authorization 헤더로만** 쓰인다. MediaMTX는 v1.18.0에서 쿼리스트링
 * 자격증명을 보안 결함으로 규정해 막았고, `authMethod: internal`은 애초에 토큰을 보지 않는다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as cam from "../cameras.ts";
import { HandlerError } from "./shared.ts";

/** DB의 check 제약과 **같은 문법**이어야 한다. 어긋나면 등록이 23514로 튕긴다. */
const PATH_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** mediamtx.yml의 recordDeleteAfter 기본값(7d)과 **같은 숫자**여야 한다. 어긋나면 화면이
 *  실제보다 긴 보관기간을 말하고, 안내판에도 그렇게 약속한 것이 된다. */
const DEFAULT_RETENTION_DAYS = 7;

interface StreamConfig {
  liveBase: string;
  playbackBase: string;
  user: string;
  pass: string;
}

/**
 * 넷 중 하나라도 비면 **미설정으로 본다.** 반쪽 설정으로 화면을 열면 '재생이 안 되는데
 * 왜인지 모르는' 상태가 되고, 그건 카메라가 고장 난 것과 구분되지 않는다.
 */
function streamConfig(): StreamConfig | null {
  const liveBase = (Deno.env.get("CAMERA_LIVE_BASE") ?? "").replace(/\/+$/, "");
  const playbackBase = (Deno.env.get("CAMERA_PLAYBACK_BASE") ?? "").replace(/\/+$/, "");
  const user = Deno.env.get("CAMERA_STREAM_USER") ?? "";
  const pass = Deno.env.get("CAMERA_STREAM_PASS") ?? "";
  if (!liveBase || !playbackBase || !user || !pass) return null;
  return { liveBase, playbackBase, user, pass };
}

function retentionDays(): number {
  const n = Number(Deno.env.get("CAMERA_RETENTION_DAYS"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

/**
 * 카메라 목록 + 마지막 보고 상태.
 *
 * 자격증명은 여기 담지 않는다 — 이 응답은 화면을 보는 동안 주기적으로 다시 받는 것이라,
 * 넣어두면 비밀이 필요 이상으로 자주 돌아다닌다. 자격증명은 camera_credentials로 따로 받는다.
 */
export async function cameras(sb: SupabaseClient) {
  const pairs = await cam.listCameras(sb);
  const cfg = streamConfig();
  return {
    cameras_configured: cfg !== null,
    // 주소는 비밀이 아니다(자격증명 없이는 아무것도 못 본다). 화면 조립에 필요하므로 같이 준다.
    live_base: cfg?.liveBase ?? null,
    playback_base: cfg?.playbackBase ?? null,
    // 안내판·이용약관에 적어둔 보관기간과 **같은 값**이어야 한다. 화면에 띄워 대조하게 한다.
    retention_days: retentionDays(),
    cameras: pairs.map(([c, s]) => ({
      ...c,
      state: { ...s, is_stale: cam.isStale(s), never_seen: cam.neverSeen(s) },
    })),
  };
}

/**
 * 스트림 자격증명. 화면을 열 때 한 번만 받는다.
 *
 * 미설정이면 401/503이 아니라 **명시적 오류**를 낸다 — 빈 값을 내려보내면 브라우저가
 * 인증 실패로 재생에 실패하고, 그게 '카메라 문제'처럼 보인다.
 */
export function cameraCredentials() {
  const cfg = streamConfig();
  if (!cfg) {
    throw new HandlerError(
      503,
      "CCTV 미설정 — CAMERA_LIVE_BASE·CAMERA_PLAYBACK_BASE·CAMERA_STREAM_USER·CAMERA_STREAM_PASS 필요",
    );
  }
  return { user: cfg.user, pass: cfg.pass };
}

/**
 * 카메라 등록.
 *
 * 실체(MediaMTX path)는 합정 맥에 있고 여기는 **선언**일 뿐이다. Tasmota Topic 등록과 같은
 * 계약이라 같은 함정을 갖는다 — path가 mediamtx.yml과 한 글자라도 다르면 카드는 뜨는데
 * 영상만 안 나온다. 그래서 문법을 등록 시점에 막고, 안내는 화면 쪽에 둔다.
 */
export async function registerCamera(sb: SupabaseClient, body: Record<string, unknown>) {
  const name = String(body.name ?? "").trim();
  const path = String(body.path ?? "").trim();
  if (!name) throw new HandlerError(400, "이름이 필요합니다");
  if (!PATH_RE.test(path)) {
    throw new HandlerError(
      400,
      "스트림 이름은 영소문자·숫자로 시작하고 영소문자·숫자·_·- 32자 이내여야 합니다",
    );
  }

  const sortRaw = Number(body.sort);
  const sort = Number.isFinite(sortRaw) ? Math.trunc(sortRaw) : 0;

  try {
    return { camera: await cam.createCamera(sb, { name, path, sort }) };
  } catch (e) {
    // 중복·문법은 사용자가 고칠 수 있는 오류다 — 500으로 뭉뚱그리지 않는다.
    throw new HandlerError(400, e instanceof Error ? e.message : "카메라 등록 실패");
  }
}

/**
 * 등록 해제. **녹화 파일은 지우지 않는다.**
 *
 * 녹화는 합정 맥의 디스크에 있고 MediaMTX의 보관기간이 관리한다. 여기서 같이 지우면
 * 실수로 해제한 순간 증거가 사라진다 — 되돌릴 수 없는 삭제를 되돌릴 수 있는 조작(등록 해제)에
 * 딸려 보내지 않는다.
 */
export async function removeCamera(sb: SupabaseClient, body: Record<string, unknown>) {
  const id = String(body.camera_id ?? "");
  if (!(await cam.getCamera(sb, id))) throw new HandlerError(404, "카메라를 찾을 수 없습니다");
  await cam.deleteCamera(sb, id);
  return { ok: true };
}
