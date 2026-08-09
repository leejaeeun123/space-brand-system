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

import type { CompletionEntry } from "./completion.ts";

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

/** 'YYYY-MM-DD HH:MM' (KST). 채널을 읽는 사람의 시계와 같은 값이어야 한다. */
function kstStamp(at: Date): string {
  const kst = new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString();
  return `${kst.slice(0, 10)} ${kst.slice(11, 16)}`;
}

function range(from: string | null, to: string | null): string {
  if (!from || !to) return "";
  return from === to ? from : `${from} ~ ${to}`;
}

/**
 * 어떤 예약이 완료됐는지 한 줄씩. 화면에 뜬 목록과 **같은 것**이어야 한다 —
 * 담당자가 본 것과 형운이 채널에서 보는 것이 다르면 대조가 안 된다.
 */
function lines(items: CompletionEntry[]): string {
  return items
    .map((e) => `${e.date} ${e.start}–${e.end}${e.crossesMidnight ? "(익일)" : ""}  ${e.name}`)
    .join("\n");
}

/**
 * 현장 QR로 청소 완료를 표시했다.
 *
 * **0건에도 올린다.** 안 올리면 "QR이 고장났다"와 "표시할 게 없었다"가 채널에서 똑같이
 * 보인다 — 무인 운영에서 조용한 성공은 조용한 실패와 구분되지 않는다(`sweep.ts`와 같은 판단).
 *
 * 목록을 코드 블록으로 감싸는 이유는 다이제스트와 같다 — 이름에 마크다운 문자가 들어가도
 * 채널에서 보이는 것이 담당자가 화면에서 본 것과 어긋나지 않는다.
 */
export function notifyCompleted(
  count: number,
  from: string | null,
  to: string | null,
  items: CompletionEntry[],
  at: Date,
): Promise<void> {
  if (count === 0) {
    return post(
      [
        "**🧹 청소 완료 QR — 표시할 예약이 없었습니다**",
        `끝난 예약이 모두 이미 완료 상태입니다. (${kstStamp(at)} 스캔)`,
      ].join("\n"),
    );
  }
  return post(
    [
      `**🧹 청소 완료 QR** · ${count}건`,
      `${range(from, to)} 예약을 청소 완료로 표시했습니다. (${kstStamp(at)} 스캔)`,
      quote(lines(items)),
    ].join("\n"),
  );
}

/**
 * 표시하다 실패했다.
 *
 * 여기에는 **몇 건까지 됐는지**를 반드시 싣는다. 담당자는 이미 자리를 떴고, 형운이 어드민에서
 * 나머지를 손으로 채워야 하는데 '어디까지 됐나'를 모르면 전부 다시 봐야 한다.
 */
export function notifyCompleteFailed(done: number, error: string, at: Date): Promise<void> {
  return post(
    [
      "**⚠️ 청소 완료 QR 실패**",
      `사유: ${error}`,
      `이미 표시된 것: ${done}건 (${kstStamp(at)} 스캔)`,
      "",
      "나머지는 어드민에서 손으로 표시해야 합니다.",
    ].join("\n"),
  );
}
