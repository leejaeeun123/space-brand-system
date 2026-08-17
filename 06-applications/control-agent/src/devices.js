/**
 * Supabase 접근 — 단일 책임: 기기 목록 캐시와 상태·명령 쓰기.
 *
 * service_role 키를 쓴다. devices/device_state/device_commands는 RLS가 켜져 있고 정책이
 * 없어 anon 키로는 못 만지기 때문이다. 이 키가 이 맥에 있다는 건 **맥 자체가 신뢰 경계**라는
 * 뜻이다 — mosquitto 비밀번호와 같은 등급으로 다뤄야 한다(README 참조).
 */

export class DeviceRegistry {
  constructor(sb) {
    this.sb = sb;
    this.byAddress = new Map(); // Tasmota Topic → device row
  }

  /** 조명 기기 목록을 다시 읽는다. 등록/해제가 반영되도록 주기적으로도 호출한다. */
  async reload() {
    const { data, error } = await this.sb
      .from("devices")
      .select("id, name, address")
      .eq("adapter", "tasmota");
    if (error) {
      console.error("[devices] 목록 조회 실패:", error.message);
      return false;
    }
    this.byAddress = new Map((data ?? []).map((d) => [d.address, d]));
    return true;
  }

  get addresses() {
    return [...this.byAddress.keys()];
  }

  find(address) {
    return this.byAddress.get(address) ?? null;
  }

  async currentState(deviceId) {
    const { data } = await this.sb
      .from("device_state")
      .select("online, power")
      .eq("device_id", deviceId)
      .maybeSingle();
    return data ?? null;
  }

  /**
   * 상태 캐시 갱신. reported_at은 **기기가 보고한 시각**이라 여기서 채운다 —
   * 이 값이 있어야 화면이 '언제 적 상태인지'를 정직하게 말할 수 있다.
   *
   * 그래서 `reported: false`(기기 보고가 아닌 갱신 — 지금은 HTTP 폴링 실패로 online만
   * 내리는 경우뿐)면 reported_at을 **빼고** upsert한다. 넣으면 무응답 기간이 화면에서
   * 방금 본 것처럼 신선해진다. 빼면 기존 행은 그 컬럼이 유지되고(PostgREST upsert는 보낸
   * 컬럼만 갱신한다), 첫 행이면 null(보고받은 적 없음)로 남는다 — 둘 다 정직한 값이다.
   */
  async saveState(deviceId, { online, power }, { reported = true } = {}) {
    const now = new Date().toISOString();
    const row = {
      device_id: deviceId,
      online,
      power,
      attrs: {},
      updated_at: now,
    };
    if (reported) row.reported_at = now;
    const { error } = await this.sb.from("device_state").upsert(row);
    if (error) console.error("[devices] 상태 저장 실패:", error.message);
  }

  async markCommand(id, status, error = null) {
    const patch = { status, error };
    if (status === "sent") patch.sent_at = new Date().toISOString();
    const { error: e } = await this.sb.from("device_commands").update(patch).eq("id", id);
    if (e) console.error("[devices] 명령 상태 갱신 실패:", e.message);
  }

  /** 에이전트가 꺼져 있는 동안 쌓인 것들. 실행 여부는 호출부가 TTL로 판단한다. */
  async pendingCommands() {
    const { data, error } = await this.sb
      .from("device_commands")
      .select("id, command, payload, requested_at")
      .eq("status", "pending")
      .order("requested_at");
    if (error) {
      console.error("[devices] 대기 명령 조회 실패:", error.message);
      return [];
    }
    return data ?? [];
  }
}
