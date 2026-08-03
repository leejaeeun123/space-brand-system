/**
 * cameras / camera_state 접근 — 단일 책임: 카메라 인벤토리와 상태 캐시의 읽기·쓰기.
 *
 * devices.ts와 형태는 같지만 의미가 다르다. devices는 '제어할 수 있는 것'이고 여기는
 * '볼 수 있는 것'이다. 영상 자체는 이 경로를 지나가지 않는다 — 마이그레이션 주석 참조.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface Camera {
  id: string;
  name: string;
  /** MediaMTX path 이름. mediamtx.yml의 선언과 글자까지 같아야 한다. */
  path: string;
  sort: number;
}

export interface CameraState {
  camera_id: string;
  online: boolean;
  /** 최근 세그먼트가 실제로 디스크에 떨어졌나. 설정 플래그가 아니다. */
  recording: boolean;
  disk_free_gb: number | null;
  /** ⚠️ true = 위법 녹음 진행 중(개인정보 보호법 §25⑤). 마이그레이션 주석 참조. */
  has_audio: boolean;
  /** null = 이 카메라에 대해 한 번도 보고를 받은 적 없음. */
  updated_at: string | null;
}

/**
 * 보고가 끊긴 지 이 시간을 넘으면 화면의 값을 믿지 말라는 신호.
 *
 * 에이전트는 30초마다 보고한다(cameras.js). 기기(600초)보다 짧게 잡는 이유는 실패의 무게가
 * 다르기 때문이다 — 조명은 눌러 보면 살았는지 알지만, 녹화는 **분쟁이 나기 전까지 아무도
 * 확인하지 않는다.** 조용히 멈춘 녹화를 늦게 아는 것이 여기서 가장 비싼 실패다.
 */
export const CAMERA_STALE_AFTER_SECONDS = 180;

export function isStale(s: CameraState): boolean {
  if (s.updated_at === null) return false; // 미수신은 '끊김'이 아니라 '모름'이다
  return (Date.now() - Date.parse(s.updated_at)) / 1000 > CAMERA_STALE_AFTER_SECONDS;
}

export function neverSeen(s: CameraState): boolean {
  return s.updated_at === null;
}

interface CameraRow {
  id: string;
  name: string;
  path: string;
  sort: number | null;
}

interface StateRow {
  camera_id: string;
  online: boolean;
  recording: boolean;
  disk_free_gb: number | null;
  has_audio: boolean | null;
  updated_at: string | null;
}

function toCamera(r: CameraRow): Camera {
  return { id: r.id, name: r.name, path: r.path, sort: r.sort ?? 0 };
}

/**
 * 상태 행이 없거나 updated_at이 null이면 = 한 번도 보고를 못 받음.
 * 이때 recording=false를 '녹화가 멈췄다'로 읽으면 안 된다 — 모르는 것뿐이다.
 * 그래서 UI는 never_seen을 따로 받아 문구를 다르게 쓴다.
 */
function toState(cameraId: string, r: StateRow | null): CameraState {
  if (!r || r.updated_at === null) {
    return {
      camera_id: cameraId,
      online: false,
      recording: false,
      disk_free_gb: null,
      has_audio: false,
      updated_at: null,
    };
  }
  return {
    camera_id: cameraId,
    online: r.online,
    recording: r.recording,
    disk_free_gb: r.disk_free_gb,
    has_audio: r.has_audio ?? false,
    updated_at: r.updated_at,
  };
}

export async function listCameras(
  db: SupabaseClient,
): Promise<Array<[Camera, CameraState]>> {
  const { data, error } = await db
    .from("cameras")
    .select("*, camera_state(*)")
    .order("sort")
    .order("created_at");
  if (error) throw new Error(`카메라 목록 조회 실패: ${error.message}`);

  return (data ?? []).map((row) => {
    const { camera_state, ...c } = row as CameraRow & {
      camera_state: StateRow | StateRow[] | null;
    };
    // supabase-js는 1:1 조인을 객체 또는 배열로 돌려준다 — 둘 다 받는다(devices.ts와 동일).
    const s = Array.isArray(camera_state) ? (camera_state[0] ?? null) : camera_state;
    return [toCamera(c as CameraRow), toState(c.id, s)] as [Camera, CameraState];
  });
}

export async function getCamera(db: SupabaseClient, id: string): Promise<Camera | null> {
  const { data, error } = await db.from("cameras").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`카메라 조회 실패: ${error.message}`);
  return data ? toCamera(data as CameraRow) : null;
}

export async function createCamera(
  db: SupabaseClient,
  c: Omit<Camera, "id">,
): Promise<Camera> {
  const { data, error } = await db
    .from("cameras")
    .insert({ name: c.name, path: c.path, sort: c.sort })
    .select()
    .single();
  // 23505 = unique_violation → 같은 path가 이미 있다.
  // 23514 = check_violation  → path 문법이 DB 제약을 통과 못 함(핸들러가 먼저 걸러야 정상).
  if (error?.code === "23505") throw new Error("이미 등록된 스트림 이름입니다");
  if (error?.code === "23514") throw new Error("스트림 이름 형식이 올바르지 않습니다");
  if (error) throw new Error(`카메라 등록 실패: ${error.message}`);
  return toCamera(data as CameraRow);
}

export async function deleteCamera(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("cameras").delete().eq("id", id);
  if (error) throw new Error(`카메라 삭제 실패: ${error.message}`);
}
