/**
 * CCTV 상태 보고 — 단일 책임: MediaMTX와 녹화 디렉터리를 관찰해 camera_state에 쓴다.
 *
 * **영상은 이 프로세스를 지나가지 않는다.** 브라우저는 MediaMTX에 직접 붙는다. 여기는
 * "저게 지금 살아 있나, 녹화가 진짜 돌고 있나"만 어드민에 알려주는 얇은 관찰자다.
 *
 * ── 녹화 여부를 왜 파일로 판정하는가 ────────────────────────────────────────────
 * MediaMTX API에 물으면 '녹화 설정이 켜져 있다'는 답을 얻는다. 그건 우리가 알고 싶은 게
 * 아니다 — 디스크가 차거나 경로 권한이 막히면 **설정은 켜진 채로 녹화만 멈춘다.**
 * 그 상태는 분쟁이 나기 전까지 아무도 확인하지 않으므로, 몇 주 뒤에 "그날 영상이 없다"로
 * 드러난다. 그래서 설정이 아니라 **파일이 지금도 커지고 있는가**를 본다. 설정은 거짓말을
 * 하지만 mtime은 하지 않는다.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** 보고 주기. Edge Function의 CAMERA_STALE_AFTER_SECONDS(180초)보다 넉넉히 짧아야 한다. */
const REPORT_INTERVAL_MS = 30_000;

/** 카메라 등록/해제 반영 주기 (조명과 같은 값). */
const RELOAD_INTERVAL_MS = 5 * 60_000;

/**
 * 녹화 파일이 이 시간 안에 갱신됐으면 '녹화 중'으로 본다.
 *
 * MediaMTX는 recordPartDuration(1초)마다 현재 세그먼트 파일에 덧붙이므로 정상이면 mtime이
 * 늘 1초 이내다. 120초는 그 여유다 — 디스크 flush 지연이나 시계 오차로 멀쩡한 녹화를
 * '멈춤'이라 경고하면, 진짜 멈춤이 왔을 때 아무도 그 경고를 믿지 않는다.
 */
const RECORDING_FRESH_MS = 120_000;

const API_TIMEOUT_MS = 5_000;

/** 가장 최근에 수정된 파일의 mtime(ms). 디렉터리가 없거나 비었으면 null. */
async function newestMtime(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // 디렉터리 자체가 없다 = 이 카메라로 녹화된 적이 한 번도 없다. 오류가 아니다.
    return null;
  }
  let newest = null;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      // 세그먼트가 날짜별 하위 폴더로 떨어지는 recordPath 설정도 있으므로 한 단계 내려간다.
      const t = e.isDirectory() ? await newestMtime(full) : (await fs.stat(full)).mtimeMs;
      if (t !== null && (newest === null || t > newest)) newest = t;
    } catch {
      // 훑는 도중 세그먼트가 회전되며 사라질 수 있다 — 그 파일만 건너뛴다.
    }
  }
  return newest;
}

async function diskFreeGb(dir) {
  try {
    const st = await fs.statfs(dir);
    return Math.round((Number(st.bavail) * Number(st.bsize)) / 1e9);
  } catch {
    return null;
  }
}

/**
 * 비디오 코덱 화이트리스트. **여기 없는 트랙은 전부 오디오로 본다.**
 *
 * 반대로(오디오 목록을 나열) 하지 않는 이유는 틀렸을 때의 방향이다. 모르는 코덱을 오디오로
 * 보면 **불필요한 경고**가 뜨고, 비디오로 보면 **위법 녹음이 조용히 지나간다.** 전자가 낫다.
 */
const VIDEO_CODECS = new Set(["AV1", "VP9", "VP8", "H265", "H264", "M-JPEG", "MJPEG"]);

function hasAudioTrack(tracks) {
  return (tracks ?? []).some((t) => !VIDEO_CODECS.has(String(t).toUpperCase().replace("MJPEG", "M-JPEG")));
}

/**
 * path 이름 → {ready, hasAudio}. API를 못 읽으면 null(= 모름).
 *
 * 트랙까지 같이 읽는 이유는 오디오 감시다 — MediaMTX에는 오디오를 버리는 설정이 없어서
 * 카메라에서 끄는 것 말고 막을 방법이 없고, 그게 펌웨어 업데이트로 되살아나면 아무도 모른다.
 */
async function readPaths(apiUrl) {
  try {
    const res = await fetch(`${apiUrl}/v3/paths/list`, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const out = new Map();
    for (const p of body.items ?? []) {
      out.set(p.name, { ready: !!p.ready, hasAudio: hasAudioTrack(p.tracks) });
    }
    return out;
  } catch (e) {
    console.error("[camera] MediaMTX API 조회 실패:", e.message);
    return null;
  }
}

/**
 * 한 바퀴 관찰해 camera_state를 갱신한다.
 *
 * API를 못 읽었으면(ready=null) **아무것도 쓰지 않는다.** online=false로 덮으면 '카메라가
 * 죽었다'와 '내가 못 봤다'가 구분되지 않는다. 쓰지 않으면 updated_at이 늙어 화면이
 * '보고 끊김'으로 표시한다 — 그게 실제로 일어난 일이다.
 */
export async function reportOnce(sb, cfg, rows) {
  const paths = await readPaths(cfg.mediamtxApiUrl);
  if (paths === null) return;

  const free = await diskFreeGb(cfg.mediamtxRecordDir);
  const now = Date.now();

  for (const cam of rows) {
    const info = paths.get(cam.path) ?? { ready: false, hasAudio: false };
    const mtime = await newestMtime(path.join(cfg.mediamtxRecordDir, cam.path));
    const recording = mtime !== null && now - mtime < RECORDING_FRESH_MS;

    // 위법 상태라 로그에도 남긴다 — 어드민을 안 보고 있어도 흔적이 있어야 한다.
    if (info.hasAudio) {
      console.error(
        `[camera] ⚠️ ${cam.name}(${cam.path}) 스트림에 오디오 트랙이 있습니다 — ` +
          `녹음은 개인정보 보호법 제25조 제5항 위반입니다. 카메라 마이크를 끄세요.`,
      );
    }

    const { error } = await sb.from("camera_state").upsert({
      camera_id: cam.id,
      online: info.ready,
      recording,
      disk_free_gb: free,
      has_audio: info.hasAudio,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error(`[camera] ${cam.name} 상태 저장 실패:`, error.message);
  }
}

async function loadCameras(sb) {
  const { data, error } = await sb.from("cameras").select("id, name, path");
  if (error) {
    console.error("[camera] 목록 조회 실패:", error.message);
    return null;
  }
  return data ?? [];
}

/**
 * 상태 보고 루프 시작. CCTV 설정이 없으면 **조용히 아무것도 하지 않는다.**
 *
 * 조명과 냉난방은 CCTV 없이도 완결이다. 여기서 설정 누락을 치명적 오류로 다루면 카메라를
 * 아직 안 단 상태에서 에이전트 전체가 죽어 조명까지 멈춘다.
 */
export function startCameraReporter(sb, cfg) {
  if (!cfg.mediamtxRecordDir) {
    console.log("[camera] MEDIAMTX_RECORD_DIR 미설정 — CCTV 상태 보고를 건너뜁니다.");
    return null;
  }

  let rows = [];
  const reload = async () => {
    const next = await loadCameras(sb);
    if (next !== null) rows = next;
  };

  const tick = () =>
    reportOnce(sb, cfg, rows).catch((e) => console.error("[camera] 보고 실패:", e));

  reload().then(() => {
    console.log(`[camera] 카메라 ${rows.length}대 관찰 시작 (${cfg.mediamtxRecordDir})`);
    tick();
  });

  const t1 = setInterval(tick, REPORT_INTERVAL_MS);
  const t2 = setInterval(() => reload().catch(() => {}), RELOAD_INTERVAL_MS);
  return () => {
    clearInterval(t1);
    clearInterval(t2);
  };
}
