/**
 * SOLAPI 문자 발송 클라이언트 — 단일 책임: 서명·요청·에러 매핑. 무엇을 보낼지는 모른다.
 *
 * ThinQ 클라이언트와 같은 자리에 있는 층이다. 다른 점은 **실패를 던지지 않는다**는 것 —
 * 문자는 한 통이 실패해도 나머지 흐름(장부 기록·알림)이 계속 돌아야 하고, 호출부가
 * 실패 사유를 그대로 채널에 실어야 한다. 예외로 올리면 그 원문이 스택 어딘가로 사라진다.
 *
 * 인증은 HMAC-SHA256인데 **서명 입력이 `date + salt`뿐이다** — URL도 본문도 안 들어간다
 * (SDK `lib/authenticator.ts` 확인). 그래서 Web Crypto만으로 충분하고 별도 SDK가 필요 없다.
 */

/** 벤더가 규정한 표면. 바뀌면 여기만 고친다. */
const BASE_URL = "https://api.solapi.com";
const SEND_PATH = "/messages/v4/send-many/detail";

/** 벤더 왕복 상한. 넘으면 '실패'로 보고 장부에 남긴다 — 무한정 매달리면 틱 전체가 밀린다. */
const TIMEOUT_MS = 15000;

const SALT_ALPHABET = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SALT_LENGTH = 32;

export interface SolapiConfig {
  apiKey: string;
  apiSecret: string;
  /** 발신번호. **사전에 등록된 번호만 쓸 수 있다**(전기통신사업법 §84-2) — 아무 번호나 넣으면 벤더가 거절한다. */
  sender: string;
}

/**
 * 환경변수에서 설정을 읽는다. 셋이 다 있어야 '설정됨'이다 —
 * 반쪽 설정으로 보내면 벤더까지 왕복해서 401을 받고, 그 실패가 '문자 서비스 장애'처럼 보인다.
 */
export function loadConfig(): SolapiConfig | null {
  const apiKey = Deno.env.get("SOLAPI_API_KEY") ?? "";
  const apiSecret = Deno.env.get("SOLAPI_API_SECRET") ?? "";
  const sender = normalizePhone(Deno.env.get("SOLAPI_SENDER") ?? "");
  if (!apiKey || !apiSecret || !sender) return null;
  return { apiKey, apiSecret, sender };
}

/**
 * 문자로 보낼 수 있는 번호인가. 보낼 수 있으면 숫자만 남긴 형태로, 아니면 null.
 *
 * **null이 이 시스템의 분기점이다** — 번호가 없으면 자동 발송이 아니라 '문구 복사 + 사람이
 * 직접 보내기' 경로로 간다. 그래서 '애매하면 통과'가 아니라 '애매하면 null'이어야 한다.
 * 잘못된 번호로 보내면 남의 전화기에 남의 예약 정보가 간다.
 *
 * 휴대폰(01x)만 받는다. 유선번호는 문자를 못 받고, 스클이 주는 안심번호(050)도 마찬가지다.
 * **010은 11자리로 못 박는다** — 01x를 한 덩어리로 묶어 10~11자리를 허용하면 한 자리 빠뜨린
 * 010 번호가 통과한다(테스트가 실제로 잡았다). 10자리는 구형 국번(011·016~019)에만 있다.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");

  // +82 10-… 형태. 국가번호를 떼고 0을 붙인다. 결과가 01x가 아니면 건드리지 않은 셈 치고 아래에서 걸린다.
  if (digits.startsWith("82")) {
    const local = "0" + digits.slice(2);
    if (/^01/.test(local)) digits = local;
  }

  return /^(010\d{8}|01[16789]\d{7,8})$/.test(digits) ? digits : null;
}

/** 서명용 난수. 길이·문자셋은 SDK와 같게 맞춘다. */
function randomSalt(): string {
  const bytes = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => SALT_ALPHABET[b % SALT_ALPHABET.length]).join("");
}

/**
 * `date + salt`를 apiSecret으로 HMAC-SHA256 → 소문자 hex.
 *
 * 순수 함수로 빼 둔 이유는 이것만 테스트로 고정할 수 있어서다. 서명이 틀리면 벤더는
 * 401만 돌려주고 '어디가 틀렸는지'는 말해주지 않는다.
 */
export async function sign(apiSecret: string, date: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(date + salt));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 벤더가 예시로 쓰는 ISO8601 형태(`2019-07-01T00:41:48Z`)에 맞춘다.
 * `toISOString()`이 붙이는 밀리초를 떼는 것은 예시와 다른 형태로 서명 분쟁을 만들지 않기 위해서다.
 */
export function isoDate(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function authHeader(cfg: SolapiConfig, now: Date): Promise<string> {
  const date = isoDate(now);
  const salt = randomSalt();
  const signature = await sign(cfg.apiSecret, date, salt);
  return `HMAC-SHA256 apiKey=${cfg.apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

/**
 * 실패의 두 갈래. **이 구분이 이 타입의 존재 이유다.**
 * rejected=벤더가 확정 거절(4xx·건별 거절, 재시도해도 같다) → 자동 재시도 허용.
 * unknown=결과 불명(타임아웃·네트워크 예외·5xx — 벤더가 받았을 수 있다) → 자리를 막고 사람이 확인.
 */
export type SendFailure = "rejected" | "unknown";

export type SendResult =
  | { ok: true; groupId: string | null }
  | { ok: false; failure: SendFailure; error: string };

/** 응답에서 사람이 읽을 실패 사유를 뽑는다. 벤더 원문을 지어내 덮지 않는다 —
 *  '잔액 부족'이나 '미등록 발신번호' 같은 진짜 원인이 거기에만 적혀 있다. */
function describeFailure(status: number, payload: unknown): string {
  const body = payload as Record<string, unknown> | null;
  const code = body?.errorCode ?? body?.statusCode;
  const message = body?.errorMessage ?? body?.statusMessage;
  if (code || message) return `${code ?? status}: ${message ?? ""}`.trim();
  return `HTTP ${status}`;
}

/**
 * HTTP 상태를 '확정 거절'과 '결과 불명'으로 가른다 — 순수 함수(테스트가 여기 붙는다).
 *
 * 4xx = 벤더가 요청을 확정적으로 거절(미등록 발신번호·잔액 부족 등, 다시 보내도 같다) → rejected.
 * 5xx = 벤더 서버 오류 — 요청을 **처리했는지 알 수 없다** → unknown. 재시도하면 유료 문자가
 *   손님에게 두 번 갈 수 있어, 자리를 막고 사람이 콘솔에서 확인한다.
 */
export function classifyHttpFailure(status: number): SendFailure {
  return status >= 500 ? "unknown" : "rejected";
}

/**
 * HTTP 200 안의 건별 거절에서 사람이 읽을 사유를 뽑는다 — 순수 함수(테스트가 여기 붙는다).
 *
 * **아는 필드만 골라 싣는다.** 예전에는 `statusMessage`가 없으면 실패 항목 전체를
 * `JSON.stringify`로 폴백했는데, 벤더가 항목에 요청 원문(`text`)을 에코하는 응답 형태면
 * 발송 전문이 error에 통째로 실린다. 이 error는 `cleaning_sms.error`(장부)와 Mattermost
 * 채널로 그대로 흐르므로(cleaning/dispatch.ts), `smsOnly`로 장부·채널에서 떼어낸 비밀번호가
 * 실패 한 번에 두 곳으로 되돌아오는 경로였다 — 여기서 끊는다.
 */
export function describeRejected(first: Record<string, unknown> | undefined): string {
  const code = typeof first?.statusCode === "string" || typeof first?.statusCode === "number"
    ? String(first.statusCode)
    : "거절";
  const message = typeof first?.statusMessage === "string" && first.statusMessage !== ""
    ? first.statusMessage
    : "사유 미기재";
  const to = typeof first?.to === "string" && first.to !== "" ? ` (to: ${first.to})` : "";
  return `${code}: ${message}${to}`;
}

/**
 * 한 통 보낸다. **어떤 예외도 밖으로 던지지 않는다.**
 *
 * `type`을 명시하는 이유: 자동 판별에 맡기면 문구를 조금 줄였을 때 조용히 SMS로 떨어져
 * 45자에서 잘린다. 이 시스템의 문구는 전부 LMS 길이이므로 못 박는다.
 */
export async function send(cfg: SolapiConfig, to: string, text: string): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(BASE_URL + SEND_PATH, {
      method: "POST",
      headers: {
        "Authorization": await authHeader(cfg, new Date()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ to, from: cfg.sender, text, type: "LMS" }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // 타임아웃(AbortSignal)·네트워크 예외 — 벤더에 닿았는지, 닿았다면 처리됐는지 알 수 없다.
    return { ok: false, failure: "unknown", error: `발송 요청 실패: ${e instanceof Error ? e.message : String(e)}` };
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, failure: classifyHttpFailure(res.status), error: describeFailure(res.status, payload) };

  // HTTP 200이어도 개별 건이 거절될 수 있다 — 그게 여기 실린다. 200만 보고 성공으로 적으면
  // 장부에는 '보냄'인데 손님은 못 받은 상태가 된다.
  const body = payload as Record<string, unknown> | null;
  const failed = body?.failedMessageList;
  if (Array.isArray(failed) && failed.length > 0) {
    return {
      ok: false,
      // 벤더가 HTTP 200으로 받았지만 이 건을 확정 거절했다 — 재시도해도 같다.
      failure: "rejected",
      error: describeRejected(failed[0] as Record<string, unknown>),
    };
  }

  const groupInfo = body?.groupInfo as Record<string, unknown> | undefined;
  return { ok: true, groupId: (groupInfo?.groupId as string | undefined) ?? null };
}
