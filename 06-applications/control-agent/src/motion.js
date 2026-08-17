/**
 * 움직임 감시 — 단일 책임: 라운지 카메라를 구독해 **"움직임이 있었다"는 시각 하나**를 적는다.
 *
 * `cameras.js`와 같은 태도다 — 설정이 아니라 **관측된 사실**을 기록하고, 못 읽었으면
 * 아무것도 쓰지 않는다. 판정("퇴실 후 창 안이었나")은 서버가 한다
 * (`supabase/functions/control/automation/occupancy.ts`).
 *
 * ── 영상은 여기를 지나가지 않는다 ────────────────────────────────────────────
 * ONVIF 이벤트는 "언제 움직임이 있었다"는 타임스탬프뿐이다. 프레임도 스냅샷도 받지 않고,
 * 이력도 쌓지 않는다(카메라 1대당 1행을 덮어쓴다). 사람이 공간에 있었던 시간대가 통째로
 * DB에 남는 것은 우리가 쓰지도 않을 개인정보다.
 *
 * ⚠️ **이 파일은 `control-agent`의 index.js가 아니라 카메라 relay `.app` 아래에서 돈다.**
 * macOS 26이 로컬 네트워크 접근을 바이너리 단위로 통제해, launchd가 띄운 Node는 카메라
 * IP에 `EHOSTUNREACH`가 난다(2026-08-18 실측 — 터미널에서는 같은 코드가 200이다).
 * 그 권한을 이미 통과한 주체가 `TypeLoungeCameraRelay.app`이라 거기에 얹었다.
 * 자세한 배경은 `cctv-setup.md`와 `.specs/spec_cctv/PROGRESS.md`에 있다.
 */

import { isMotion, pull, renew, subscribe, unsubscribe } from "./onvif.js";

/** 폴링 간격. 카메라가 롱폴링을 안 하므로 **이 값이 곧 감지 지연의 상한**이다. */
const POLL_INTERVAL_MS = 2_000;

/** 구독 수명(PT10M)보다 넉넉히 짧게. 만료를 기다렸다 실패로 재구독하면 10분마다 버스트가 난다. */
const RENEW_INTERVAL_MS = 4 * 60_000;

/**
 * 움직임이 없어도 이 주기로 '살아 있음'을 적는다.
 *
 * 서버가 이 값의 나이로 '움직임 없음'과 '감시자가 죽어서 모름'을 가른다
 * (`occupancy.ts`의 `MOTION_STALE_SECONDS = 180`). 매 폴링마다 쓰면 카메라당 분당 30건이라
 * 쓸데없이 시끄럽고, 안 쓰면 서버가 영영 '모름'으로 본다. `cameras.js`와 같은 30초.
 */
const HEARTBEAT_MS = 30_000;

/** pull이 이만큼 연속 실패하면 구독이 죽은 것으로 보고 다시 맺는다. */
const REFRESH_AFTER_FAILURES = 3;

/** path → camera_id. DB의 선언이 실체(`mediamtx.yml`의 path)와 이어지는 유일한 지점이다. */
async function resolveIds(sb, paths) {
  const { data, error } = await sb.from("cameras").select("id, path").in("path", paths);
  if (error) throw new Error(`카메라 목록 조회 실패: ${error.message}`);
  return new Map((data ?? []).map((c) => [c.path, c.id]));
}

/**
 * 관측 1건 기록.
 *
 * `last_motion_at`은 **움직임을 봤을 때만** 넘긴다 — 매번 넘기면 null로 덮어써서
 * 방금 본 움직임이 지워진다.
 */
async function save(sb, cameraId, { motionAt, now }) {
  const row = { camera_id: cameraId, observed_at: now.toISOString() };
  if (motionAt) row.last_motion_at = motionAt.toISOString();
  const { error } = await sb.from("camera_motion").upsert(row);
  if (error) console.error(`[motion] ${cameraId} 기록 실패:`, error.message);
}

/** 카메라 한 대를 계속 지켜본다. 스스로 재구독하며 영원히 돈다. */
async function watchOne(sb, { path, ip, id }, creds, state) {
  let sub = null;
  let failures = 0;
  let lastRenew = 0;
  let lastHeartbeat = 0;

  while (!state.stopped) {
    try {
      if (!sub) {
        sub = await subscribe(ip, creds);
        failures = 0;
        lastRenew = Date.now();
        console.log(`[motion] ${path} 구독 시작`);
      }

      if (Date.now() - lastRenew > RENEW_INTERVAL_MS) {
        await renew(sub, creds);
        lastRenew = Date.now();
      }

      const events = await pull(sub, creds);
      failures = 0;

      // 한 번의 pull에 여러 건이 실려 올 수 있다 — 가장 늦은 것이 '마지막 움직임'이다.
      let motionAt = null;
      for (const e of events) {
        if (!isMotion(e.topic)) continue;
        if (motionAt === null || e.at > motionAt) motionAt = e.at;
      }

      const now = new Date();
      if (motionAt) {
        // 움직임은 **즉시** 적는다. 하트비트 주기를 기다리면 그만큼 판정이 늦는다.
        await save(sb, id, { motionAt, now });
        lastHeartbeat = Date.now();
        console.log(`[motion] ${path} 움직임 ${motionAt.toISOString()}`);
      } else if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
        await save(sb, id, { motionAt: null, now });
        lastHeartbeat = Date.now();
      }
    } catch (e) {
      failures++;
      // 실패한 틱에는 **아무것도 쓰지 않는다.** observed_at을 갱신하면 못 본 시간이
      // '정상 관측'으로 남아, 감시자가 죽은 채로 "아무도 없습니다"가 참이 된다.
      if (failures === 1) console.error(`[motion] ${path} pull 실패:`, e.message);
      if (failures >= REFRESH_AFTER_FAILURES) {
        console.error(`[motion] ${path} ${failures}회 실패 — 구독을 다시 맺는다`);
        sub = null;
        failures = 0;
      }
      await sleep(2_000);
      continue;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (sub) await unsubscribe(sub, creds).catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 감시 시작. `cameras` 목록은 `[{ path, ip }]`.
 *
 * 등록되지 않은 path는 **건너뛰되 로그를 남긴다.** 조용히 빠지면 그 카메라만 영원히 안 보이고,
 * 어드민에도 흔적이 없어 아무도 모른다(`camera-relay-all.sh`와 어드민 등록이 어긋난 경우다).
 */
export async function startMotionWatch(sb, cameras, creds) {
  const ids = await resolveIds(sb, cameras.map((c) => c.path));
  const state = { stopped: false };

  const targets = [];
  for (const c of cameras) {
    const id = ids.get(c.path);
    if (!id) {
      console.error(`[motion] '${c.path}'가 cameras 테이블에 없다 — 어드민에서 등록해야 감시된다`);
      continue;
    }
    targets.push({ ...c, id });
  }

  if (!targets.length) {
    console.error("[motion] 감시할 카메라가 하나도 없다.");
    return () => {};
  }

  console.log(`[motion] 카메라 ${targets.length}대 감시 시작 (${targets.map((t) => t.path).join(", ")})`);
  for (const t of targets) {
    watchOne(sb, t, creds, state).catch((e) => console.error(`[motion] ${t.path} 감시 중단:`, e));
  }
  return () => {
    state.stopped = true;
  };
}
