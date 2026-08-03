/**
 * devices / device_state 접근 — 단일 책임: 기기 인벤토리와 상태 캐시의 읽기·쓰기.
 *
 * service_role 키로 붙는다. 두 테이블은 RLS가 켜져 있고 정책이 없어 anon 키로는 못 만진다
 * (마이그레이션 주석 참조) — 즉 이 파일이 유일한 접근 경로다.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Device, DeviceConstraints, DeviceState } from "./types.ts";

export function dbClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

interface DeviceRow {
  id: string;
  name: string;
  kind: Device["kind"];
  adapter: Device["adapter"];
  address: string;
  capabilities: string[] | null;
  constraints: DeviceConstraints | null;
}

interface StateRow {
  device_id: string;
  online: boolean;
  power: "ON" | "OFF" | null;
  attrs: Record<string, unknown> | null;
  reported_at: string | null;
  updated_at: string | null;
}

function toDevice(r: DeviceRow): Device {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    adapter: r.adapter,
    address: r.address,
    capabilities: r.capabilities ?? [],
    constraints: r.constraints,
  };
}

/**
 * 상태 행이 없으면 = 이 기기로부터 한 번도 상태를 받은 적 없음.
 * updated_at을 null로 남긴다 — 지금 시각을 채우면 '방금 갱신됨'이라는 거짓말이 되고,
 * UI가 '0초 전'이라 표시해 신선한 상태처럼 보인다. power=null('모름')도 'OFF'가 아니다.
 */
function toState(deviceId: string, r: StateRow | null): DeviceState {
  if (!r || r.updated_at === null) {
    return { device_id: deviceId, online: false, power: null, attrs: {}, reported_at: null, updated_at: null };
  }
  return {
    device_id: deviceId,
    online: r.online,
    power: r.power,
    attrs: r.attrs ?? {},
    reported_at: r.reported_at,
    updated_at: r.updated_at,
  };
}

/** 기기 + 마지막 알려진 상태. 조회 비용은 DB 왕복뿐 — 기기 부하 0. */
export async function listDevices(db: SupabaseClient): Promise<Array<[Device, DeviceState]>> {
  const { data, error } = await db
    .from("devices")
    .select("*, device_state(*)")
    .order("kind")
    .order("created_at");
  if (error) throw new Error(`기기 목록 조회 실패: ${error.message}`);

  return (data ?? []).map((row) => {
    const { device_state, ...d } = row as DeviceRow & { device_state: StateRow | StateRow[] | null };
    // supabase-js는 1:1 조인을 객체 또는 배열로 돌려준다 — 둘 다 받는다.
    const s = Array.isArray(device_state) ? (device_state[0] ?? null) : device_state;
    return [toDevice(d as DeviceRow), toState(d.id, s)] as [Device, DeviceState];
  });
}

export async function getDevice(db: SupabaseClient, id: string): Promise<Device | null> {
  const { data, error } = await db.from("devices").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`기기 조회 실패: ${error.message}`);
  return data ? toDevice(data as DeviceRow) : null;
}

export async function createDevice(
  db: SupabaseClient,
  d: Omit<Device, "id">,
): Promise<Device> {
  const { data, error } = await db
    .from("devices")
    .insert({
      name: d.name,
      kind: d.kind,
      adapter: d.adapter,
      address: d.address,
      capabilities: d.capabilities,
      constraints: d.constraints,
    })
    .select()
    .single();
  // 23505 = unique_violation → 같은 어댑터에 같은 주소가 이미 있다.
  if (error?.code === "23505") throw new Error("이미 등록된 기기입니다");
  if (error) throw new Error(`기기 등록 실패: ${error.message}`);
  return toDevice(data as DeviceRow);
}

export async function deleteDevice(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("devices").delete().eq("id", id);
  if (error) throw new Error(`기기 삭제 실패: ${error.message}`);
}

/** 상태 캐시 1건 갱신. 조명 브릿지·ThinQ 폴링이 공유하는 단일 쓰기 경로. */
export async function upsertState(db: SupabaseClient, s: DeviceState): Promise<void> {
  const { error } = await db.from("device_state").upsert({
    device_id: s.device_id,
    online: s.online,
    power: s.power,
    attrs: s.attrs,
    reported_at: s.reported_at,
    updated_at: s.updated_at ?? new Date().toISOString(),
  });
  if (error) throw new Error(`상태 갱신 실패: ${error.message}`);
}


/**
 * 조명 명령을 큐에 넣는다. 합정 에이전트가 Realtime으로 이 INSERT를 받아 발행한다.
 *
 * topic/payload를 여기서 완성해 넣는다 — 토픽 문법을 아는 곳은 한 군데여야 한다.
 * 에이전트가 따로 조립하게 하면 양쪽 문법이 어긋나는 순간 명령이 **에러 없이 조용히** 사라진다.
 */
export async function enqueueCommand(
  db: SupabaseClient,
  deviceId: string,
  command: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await db
    .from("device_commands")
    .insert({ device_id: deviceId, command, payload })
    .select("id")
    .single();
  if (error) throw new Error(`명령 등록 실패: ${error.message}`);
  return (data as { id: string }).id;
}
