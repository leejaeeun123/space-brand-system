/**
 * ONVIF 이벤트 전송 계층 — 단일 책임: 카메라와 SOAP로 말한다. 판정도 DB도 여기 없다.
 *
 * ── 왜 라이브러리를 안 쓰나 ──────────────────────────────────────────────────
 * `onvif-zeep`는 `PullMessages`를 엉뚱한 네임스페이스(`rw-2`)에서 찾아 `LookupError`로 죽는다
 * (2026-08-18 실측). 우리가 쓰는 호출은 넷뿐이라 직접 조립하는 편이 짧고 확실하다.
 *
 * ── 이 카메라(Tapo TC71 · FW 1.5.4)의 성질 셋. 전부 실측이다 ─────────────────
 *
 *   1. **`PullMessages`의 `Timeout`은 `PT9S` 이하여야 한다.** `PT10S` 이상을 주면 응답 없이
 *      11초에 연결을 끊는다. 그걸 구독 만료로 오해해 재구독하면 초당 몇 번씩 재구독하는
 *      폭주가 된다 — 실제로 한 번 빠졌다.
 *   2. **롱폴링을 하지 않는다.** `Timeout`을 얼마로 주든 큐에 있는 것만 즉시 돌려준다.
 *      그래서 감지 지연의 상한은 카메라가 아니라 **우리가 정하는 폴링 간격**이다.
 *   3. **WS-Security(UsernameToken PasswordDigest)가 필수다.** 없으면 `Authority failure`.
 *      WS-Addressing(`To`·`Action`)은 있어도 없어도 된다.
 */

import crypto from "node:crypto";

const NS_EVENTS = "http://www.onvif.org/ver10/events/wsdl";
const NS_WSNT = "http://docs.oasis-open.org/wsn/b-2";

/** 구독 수명. 이보다 넉넉히 짧은 주기로 `renew`를 불러야 한다. */
export const TERMINATION = "PT10M";

/** ⚠️ PT9S를 넘기지 말 것 — 위 성질 1. */
const PULL_TIMEOUT = "PT5S";

const HTTP_TIMEOUT_MS = 20_000;

function securityHeader(user, pass) {
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const digest = crypto
    .createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created, "utf8"), Buffer.from(pass, "utf8")]))
    .digest("base64");
  return (
    '<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
    `<UsernameToken><Username>${user}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
    "</UsernameToken></Security>"
  );
}

/** SOAP 1.2 요청 1건. 성공하면 본문 문자열, 실패하면 던진다. */
async function soap(url, body, { user, pass }) {
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
    `<s:Header>${securityHeader(user, pass)}</s:Header>` +
    `<s:Body>${body}</s:Body></s:Envelope>`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
    body: envelope,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok || text.includes("Fault")) {
    const reason = /<[^>]*Text[^>]*>([^<]+)</.exec(text)?.[1] ?? `HTTP ${res.status}`;
    throw new Error(reason.slice(0, 120));
  }
  return text;
}

/** 이벤트 서비스 주소. 기기 서비스(`/onvif/device_service`)와 다르다. */
export function eventsUrl(ip) {
  return `http://${ip}:2020/onvif/service`;
}

/**
 * PullPoint 구독 생성 → 구독 전용 URL을 돌려준다.
 *
 * 카메라는 구독마다 **별도 포트**(1024~)를 연다. 이후 `pull`·`renew`·`unsubscribe`는
 * 전부 이 URL로 보낸다 — 이벤트 서비스 주소로 보내면 엉뚱한 구독을 건드린다.
 */
export async function subscribe(ip, creds) {
  const xml = await soap(
    eventsUrl(ip),
    `<CreatePullPointSubscription xmlns="${NS_EVENTS}">` +
      `<InitialTerminationTime>${TERMINATION}</InitialTerminationTime></CreatePullPointSubscription>`,
    creds,
  );
  const addr = /<[^>]*SubscriptionReference>[\s\S]*?<[^>]*Address[^>]*>([^<]+)</.exec(xml)?.[1];
  if (!addr) throw new Error("구독 응답에 SubscriptionReference가 없다");
  return addr;
}

/**
 * 구독 수명 연장. **만료를 기다렸다 실패로 재구독하면 10분마다 실패 버스트가 난다** —
 * 호출부가 주기 타이머로 선제 호출한다.
 */
export function renew(subscriptionUrl, creds) {
  return soap(
    subscriptionUrl,
    `<Renew xmlns="${NS_WSNT}"><TerminationTime>${TERMINATION}</TerminationTime></Renew>`,
    creds,
  );
}

export function unsubscribe(subscriptionUrl, creds) {
  return soap(subscriptionUrl, `<Unsubscribe xmlns="${NS_WSNT}"/>`, creds);
}

/**
 * 쌓인 알림을 꺼낸다 → `[{ topic, at, active }]`.
 *
 * `at`은 **카메라가 실어 보낸 `UtcTime`**이지 우리가 받은 시각이 아니다. 폴링 간격만큼 늦게
 * 받으므로 수신 시각으로 적으면 퇴실 직전의 움직임이 판정 창 안으로 밀려 들어와,
 * 이미 나간 손님을 붙잡는다. 카메라 시계는 맥과 1초 이내로 맞는 것을 확인했다(2026-08-18).
 *
 * `UtcTime`을 못 읽은 알림은 **버린다.** 지금 시각으로 대체하면 위의 밀림이 그대로 생긴다 —
 * 시각을 모르는 감지는 이 기능에 쓸 수 없다.
 *
 * `active`는 Data의 SimpleItem 값(`IsMotion="true"` 등)이다. CellMotionDetector는 상태형
 * (Property) 이벤트라 **시작(true)과 종료(false)가 같은 토픽으로 온다** — 값을 안 읽으면
 * '움직임이 끝났다'는 알림이 움직임으로 집힌다. 종료는 감지 홀드가 풀리는 몇 초 뒤에 오므로,
 * 유예 안에 나간 손님의 종료 이벤트가 유예 밖 시각을 달고 와 정상 퇴실을 오탐시킨다.
 * 값이 아예 없으면 null로 둔다 — 버릴지는 의미를 아는 쪽(`isMotion`)이 정한다.
 */
export async function pull(subscriptionUrl, creds) {
  const xml = await soap(
    subscriptionUrl,
    `<PullMessages xmlns="${NS_EVENTS}">` +
      `<Timeout>${PULL_TIMEOUT}</Timeout><MessageLimit>50</MessageLimit></PullMessages>`,
    creds,
  );

  const out = [];
  const blocks = xml.matchAll(/<[^>]*NotificationMessage>([\s\S]*?)<\/[^>]*NotificationMessage>/g);
  for (const [, block] of blocks) {
    const utc = /UtcTime="([^"]+)"/.exec(block)?.[1];
    if (!utc) continue;
    const at = new Date(utc);
    if (Number.isNaN(at.getTime())) continue;
    const topic = (/<[^>]*Topic[^>]*>([^<]+)</.exec(block)?.[1] ?? "").trim();
    // Source의 SimpleItem(VideoSourceConfigurationToken 등)과 섞이지 않게 Data 안에서만 읽는다.
    const data = /<[^>]*Data>([\s\S]*?)<\/[^>]*Data>/.exec(block)?.[1] ?? "";
    const value = /Value="([^"]+)"/.exec(data)?.[1] ?? null;
    out.push({
      topic: topic.split("/").pop() ?? topic,
      at,
      active: value === null ? null : value === "true",
    });
  }
  return out;
}

/**
 * 이 알림이 **움직임**인가.
 *
 * `CellMotionDetector`만 본다. 이 카메라가 광고하는 토픽에는 `PeopleDetector`·`LineCross`·
 * `Intrusion`도 있지만 **실제로 가동 중인 분석 모듈은 `CellMotionEngine`과 `TamperEngine`
 * 둘뿐**이라(2026-08-18 `GetAnalyticsModules` 실측), 나머지는 오지 않는다.
 *
 * `Tamper`(가림 감지)를 일부러 뺀다 — 렌즈를 가린 것은 '사람이 있다'와 다른 사건이고,
 * 여기 섞으면 퇴실 독려 알림이 엉뚱한 이유로 뜬다.
 *
 * 나중에 Tapo 앱에서 사람 감지를 켜면 `PeopleDetector`가 오기 시작한다. 그때 여기 한 줄을
 * 더하면 되고, **그 전까지 판정은 사람이 아니라 움직임이다**(오탐 여지가 그만큼 있다).
 *
 * `active === false`(움직임 종료)는 움직임이 아니다 — `pull`의 주석에 있는 오탐 경로다.
 * `null`(값을 못 읽음)은 **움직임으로 친다**: FW가 바뀌어 파서가 값을 놓치는 날, 종료까지
 * 세는 과민함은 눈에 띄지만(오탐 알림) 전부 버리는 과묵함은 기능이 조용히 꺼진 채 아무도
 * 모른다. 조용한 고장이 더 나쁘다는 태도는 `motion.js`의 실패 처리와 같다.
 */
export function isMotion(event) {
  return event.topic === "Motion" && event.active !== false;
}
