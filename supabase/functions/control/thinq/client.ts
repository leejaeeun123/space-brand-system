/**
 * LG ThinQ Connect HTTP 클라이언트 — 단일 책임: 헤더 빌드·요청·에러 매핑.
 *
 * Space(src/control/thinq/client.py)의 이식. 상태를 들고 있지 않다 — 요청마다 새 fetch.
 * 문서가 control에 대해 규정한 응답은 200/400/401뿐이라, 그 밖(429·5xx)은
 * 지어내지 않고 전부 '벤더 이상'으로 묶는다(현상유지 = 기기를 건드리지 않음).
 */

export class ThinQError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ThinQError";
    this.status = status;
  }
}

/** 401 — PAT 만료/무효. 재시도 금지(자동 재발급 경로가 없다). 수동 갱신이 유일한 길. */
export class ThinQAuthError extends ThinQError {}

/** 400 — 범위/enum 위반. 대부분 constraints 검증으로 우리가 먼저 막아야 한다. */
export class ThinQBadRequest extends ThinQError {}

/** 네트워크/타임아웃/5xx — 현상유지(fail-safe). */
export class ThinQUnavailable extends ThinQError {}

export interface ThinQConfig {
  pat: string;
  clientId: string;
  apiKey: string;
  country: string;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * 설정을 환경변수에서 읽는다. PAT·clientId·apiKey 셋이 다 있어야 '설정됨'이다.
 * 반쪽 설정으로 호출하면 401을 벤더까지 왕복해서 받게 되므로 여기서 먼저 막는다.
 */
export function loadConfig(): ThinQConfig | null {
  const pat = Deno.env.get("THINQ_PAT") ?? "";
  const clientId = Deno.env.get("THINQ_CLIENT_ID") ?? "";
  const apiKey = Deno.env.get("THINQ_API_KEY") ?? "";
  if (!pat || !clientId || !apiKey) return null;
  return {
    pat,
    clientId,
    apiKey,
    country: Deno.env.get("THINQ_COUNTRY") ?? "KR",
    // KIC = Korea. 리전이 바뀌면 이 값만 갈아끼운다.
    baseUrl: Deno.env.get("THINQ_BASE_URL") ?? "https://api-kic.lgthinq.com",
    timeoutMs: Number(Deno.env.get("THINQ_TIMEOUT_MS") ?? "10000"),
  };
}

/**
 * url-safe base64, 패딩 없음, UUID v4 → 정확히 22자(ThinQ 명세 규정).
 * 응답의 messageId가 이 값을 되돌려주므로 장애 시 요청 추적에 쓴다. 요청마다 새로 생성.
 */
export function messageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class ThinQClient {
  constructor(private cfg: ThinQConfig) {}

  /** 공통 5종. x-message-id만 요청마다 새로 생성한다. */
  private headers(): HeadersInit {
    return {
      "Authorization": `Bearer ${this.cfg.pat}`,
      "x-message-id": messageId(),
      "x-country": this.cfg.country,
      "x-client-id": this.cfg.clientId,
      "x-api-key": this.cfg.apiKey,
      "Content-Type": "application/json",
    };
  }

  /** 등록된 기기 목록. response가 배열로 온다. */
  async getDevices(): Promise<unknown[]> {
    const data = await this.request("GET", "/devices");
    return Array.isArray(data) ? data : [];
  }

  /** 기기 프로파일 — capabilities/constraints 파생의 원천(profile.ts). */
  async getProfile(deviceId: string): Promise<Record<string, unknown>> {
    return await this.request("GET", `/devices/${deviceId}/profile`) as Record<string, unknown>;
  }

  /** 기기 현재 상태 — DeviceState 매핑의 원천(state.ts). */
  async getState(deviceId: string): Promise<Record<string, unknown>> {
    return await this.request("GET", `/devices/${deviceId}/state`) as Record<string, unknown>;
  }

  /** 제어 명령 발행. 200이면 response는 빈 객체(문서 명시). */
  async control(deviceId: string, body: unknown): Promise<unknown> {
    return await this.request("POST", `/devices/${deviceId}/control`, body);
  }

  /**
   * 단일 요청 + 에러 매핑 + 제한적 재시도.
   *
   * 네트워크/5xx는 1회만 재시도한다 — 사용자가 버튼 앞에서 기다리고 있어 백오프가 무의미하다.
   * 401/400은 재시도하지 않는다(PAT 무효 시 잠금 위험 / 같은 요청은 또 400).
   */
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let last: ThinQUnavailable | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.sendOnce(method, path, body);
      } catch (e) {
        if (!(e instanceof ThinQUnavailable)) throw e;
        last = e;
      }
    }
    throw last;
  }

  private async sendOnce(method: string, path: string, body?: unknown): Promise<unknown> {
    let resp: Response;
    try {
      resp = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      throw new ThinQUnavailable(`ThinQ 연결 실패: ${e instanceof Error ? e.message : e}`);
    }
    return await this.handle(resp);
  }

  /** 상태코드 → 예외 매핑. 성공이면 response 페이로드를 벗겨 돌려준다. */
  private async handle(resp: Response): Promise<unknown> {
    if (resp.status === 200) {
      let parsed: unknown = {};
      try {
        parsed = await resp.json();
      } catch {
        return {};
      }
      if (parsed && typeof parsed === "object" && "response" in parsed) {
        return (parsed as { response: unknown }).response ?? {};
      }
      return {};
    }
    const text = await resp.text().catch(() => "");
    if (resp.status === 400) throw new ThinQBadRequest(`ThinQ 400 잘못된 요청: ${text}`, 400);
    if (resp.status === 401) {
      throw new ThinQAuthError("ThinQ 401 인증 실패 — PAT 만료/무효(재시도 금지)", 401);
    }
    throw new ThinQUnavailable(`ThinQ ${resp.status}: ${text}`, resp.status);
  }
}
