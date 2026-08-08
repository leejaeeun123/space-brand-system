/**
 * 청소 안내를 Mattermost에 올린다 — 단일 책임: 채널 게시.
 *
 * 손님 문자 알림(`sms/notify.ts`)은 '무엇을 누구에게 보냈다' 한 줄만 올리는데, 여기는
 * **본문을 통째로 올린다.** 형운이 문자를 받지 않고 채널로 같은 것을 보기 때문이다
 * (형운 지시, 2026-08-09). LMS 한 통 값이 더 들지 않으면서 두 사람이 같은 것을 본다.
 *
 * 본문을 코드 블록으로 감싼다 — `+ 추가` 같은 줄이 마크다운 불릿으로 렌더되면 담당자가
 * 실제로 받은 문자와 채널에 보이는 것이 달라진다.
 *
 * 빌려온 규율 하나: **어떤 예외도 밖으로 던지지 않는다.** 알림이 실패했다고 이미 나간
 * 문자가 장부에 안 적히면 안 된다.
 */

export type CleaningKind = "digest" | "update";

export const KIND_LABEL: Record<CleaningKind, string> = {
  digest: "청소 안내",
  update: "예약 변경",
};

/** 문자 전용 웹훅이 있으면 그쪽, 없으면 기존 채널. `sms/notify.ts`와 같은 규칙이다. */
function webhookUrl(): string | null {
  return Deno.env.get("MATTERMOST_SMS_WEBHOOK_URL") ??
    Deno.env.get("MATTERMOST_WEBHOOK_URL") ?? null;
}

function quote(body: string): string {
  return "```\n" + body + "\n```";
}

async function post(text: string): Promise<void> {
  const url = webhookUrl();
  if (!url) {
    console.warn("MATTERMOST_WEBHOOK_URL 미설정 — 청소 안내 알림을 건너뛴다");
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
      console.error(`청소 안내 알림 실패 (${res.status})`, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("청소 안내 알림 예외", e);
  }
}

export function notifySent(kind: CleaningKind, body: string): Promise<void> {
  return post(`**청소 담당자 · ${KIND_LABEL[kind]}** · 문자 발송 완료\n${quote(body)}`);
}

/**
 * 실패에는 **본문을 반드시 싣는다.** 형운이 그 자리에서 복사해 직접 보낼 수 있어야 하고,
 * 그게 이 기능에서 재시도를 열지 않은 근거이기도 하다.
 */
export function notifyFailed(kind: CleaningKind, body: string, error: string): Promise<void> {
  return post(
    [
      `**⚠️ 청소 안내 문자 실패 · ${KIND_LABEL[kind]}**`,
      `사유: ${error}`,
      "",
      "손으로 보내야 합니다 — 아래 본문을 그대로 복사하세요.",
      quote(body),
    ].join("\n"),
  );
}

/**
 * 문자를 보내지 않는 시간대(22시 이후)라 채널에만 남긴 것.
 *
 * **조용히 넘기지 않는다** — 무인 공간에서 안 나간 안내는 아무도 모르면 없었던 일이 된다.
 */
export function notifyQuiet(kind: CleaningKind, body: string): Promise<void> {
  return post(
    [
      `**🌙 ${KIND_LABEL[kind]} — 문자는 보내지 않았습니다**`,
      "문자를 보내지 않는 시간대(22시 이후)라 여기에만 남깁니다.",
      quote(body),
    ].join("\n"),
  );
}
