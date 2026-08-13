/**
 * 문자 발송 결과를 Mattermost에 올린다 — 단일 책임: 한 건, 한 줄.
 *
 * 기기 알림(`automation/notify.ts`)의 선점·묶음 장치를 쓰지 않는다. 그쪽은 입실 준비 한 번이
 * 명령 8개를 낳아 묶지 않으면 채널을 못 쓰게 되지만, 문자는 예약당 4~5통이 몇 시간에 걸쳐
 * 나가므로 묶을 것이 없다. `device_events` 테이블에 얹지 않는 이유는 더 분명하다 —
 * 그 테이블은 `device_id`·`command`가 본질이라 문자를 넣으면 타입이 거짓말을 하게 된다.
 *
 * 빌려온 것은 규율 하나다: **어떤 예외도 밖으로 던지지 않는다.** 알림이 실패했다고
 * 이미 나간 문자가 장부에 안 적히면 안 된다.
 */

import { KIND_LABEL, type SmsKind } from "./templates.ts";

/**
 * 웹훅 주소. 문자 전용이 있으면 그쪽, 없으면 기존 채널로 간다.
 * 기기 알림이 문자를 덮으면 코드를 안 고치고 `MATTERMOST_SMS_WEBHOOK_URL`만 넣어 분리한다.
 */
function webhookUrl(): string | null {
  return Deno.env.get("MATTERMOST_SMS_WEBHOOK_URL") ??
    Deno.env.get("MATTERMOST_WEBHOOK_URL") ?? null;
}

export interface NotifyContext {
  name: string;
  kind: SmsKind;
  slot: string;
  /** 'auto' = 예약 시각에 맞춰 자동으로, 'admin' = 어드민이 눌러서. 읽는 사람에게 전혀 다른 정보다. */
  origin: "auto" | "admin";
}

/**
 * 성공에는 번호를 싣지 않고 실패에만 싣는다.
 *
 * 실패했을 때는 형운이 그 번호로 직접 보내야 하므로 채널에 있어야 유용하다. 성공했을 때는
 * 아무도 안 쓰는 값이고, 안 올리면 안 새는 값이다(`auth.ts`의 `scrubDevices`와 같은 판단).
 */
function successText(ctx: NotifyContext): string {
  const via = ctx.origin === "auto" ? "자동" : "어드민";
  return `**문자 · ${KIND_LABEL[ctx.kind]}** · ${ctx.name}\n${ctx.slot} · ${via} 발송`;
}

function failureText(ctx: NotifyContext, phone: string | null, error: string): string {
  const via = ctx.origin === "auto" ? "자동" : "어드민";
  return [
    `**⚠️ 문자 실패 · ${KIND_LABEL[ctx.kind]}** · ${ctx.name}`,
    `${ctx.slot} · ${via} 발송`,
    `수신 ${phone ?? "번호 없음"}`,
    `사유: ${error}`,
    "",
    "손으로 보내야 합니다 — 어드민에서 문구를 복사할 수 있어요.",
  ].join("\n");
}

/** 발송. 실패하면 콘솔에만 남기고 조용히 끝낸다 — 여기서 던지면 호출부의 장부 기록이 날아간다. */
async function post(text: string): Promise<void> {
  const url = webhookUrl();
  if (!url) {
    console.warn("MATTERMOST_WEBHOOK_URL 미설정 — 문자 알림을 건너뛴다");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`문자 알림 실패 (${res.status})`, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("문자 알림 예외", e);
  }
}

export function notifySent(ctx: NotifyContext): Promise<void> {
  return post(successText(ctx));
}

export function notifyFailed(
  ctx: NotifyContext,
  phone: string | null,
  error: string,
): Promise<void> {
  return post(failureText(ctx, phone, error));
}

/**
 * 창을 놓쳐 안 보낸 것. **조용히 넘기지 않는다** — 무인 공간에서 안 나간 문자는
 * 아무도 모르면 없었던 일이 되고, 손님은 안내를 못 받은 채 도착한다.
 */
export function notifyExpired(ctx: NotifyContext): Promise<void> {
  return post(
    [
      `**⚠️ 문자 미발송 · ${KIND_LABEL[ctx.kind]}** · ${ctx.name}`,
      `${ctx.slot}`,
      "보낼 시각을 놓쳐 건너뛰었습니다. 필요하면 어드민에서 재발송하세요.",
    ].join("\n"),
  );
}

/**
 * 결과 불명(타임아웃·네트워크 예외·5xx). **자동 재발송하지 않았다는 것을 분명히 한다.**
 *
 * 실패(`notifyFailed`)와 다른 문구를 쓰는 이유: 확정 거절은 다음 틱이 자동으로 다시 보내지만,
 * 결과 불명은 벤더가 이미 보냈을 수 있어 일부러 멈췄다 — 사람이 SOLAPI 콘솔에서 실제 발송
 * 여부를 확인해야 한다. 그냥 재발송하면 유료 LMS가 손님에게 중복 도달할 수 있다.
 */
export function notifyUnknown(
  ctx: NotifyContext,
  phone: string | null,
  error: string,
): Promise<void> {
  const via = ctx.origin === "auto" ? "자동" : "어드민";
  return post(
    [
      `**⚠️ 문자 결과 불명 · ${KIND_LABEL[ctx.kind]}** · ${ctx.name}`,
      `${ctx.slot} · ${via} 발송`,
      `수신 ${phone ?? "번호 없음"}`,
      `사유: ${error}`,
      "",
      "보냈는지 불분명해 자동 재발송을 멈췄습니다. SOLAPI 콘솔에서 확인 후, 안 갔으면 어드민에서 재발송하세요.",
    ].join("\n"),
  );
}
