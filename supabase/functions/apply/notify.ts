/**
 * Mattermost 발송 — 단일 책임: 조립된 한 통을 보내고, 갔는지 아닌지만 돌려준다.
 *
 * **재시도 큐가 없다.** `control/automation/notify.ts`의 선점·되돌리기 장치는 기기 이벤트가
 * 초당 여러 건씩 쌓이기 때문에 있는 것이고, 신청은 하루 몇 건짜리 단발이다. 못 보낸 건은
 * 장부의 `notified_at`이 null로 남아 드러난다 — 그걸로 충분하다고 봤다.
 */

import { buildMessage } from "./message.ts";
import type { Application } from "./validate.ts";

/**
 * 웹훅 주소. 신청 전용이 있으면 그쪽, 없으면 기존 알림과 같은 채널로 간다.
 *
 * 예약·기기 알림이 이미 쓰는 그 방식이다(2026-08-07 형운 결정) — 신청이 잦아져 다른 알림을
 * 덮으면 **코드를 고치지 않고** `MATTERMOST_APPLY_WEBHOOK_URL` 시크릿만 넣어 분리한다.
 */
function webhookUrl(): string | null {
  return Deno.env.get("MATTERMOST_APPLY_WEBHOOK_URL") ??
    Deno.env.get("MATTERMOST_WEBHOOK_URL") ?? null;
}

/**
 * 발송. **어떤 예외도 밖으로 던지지 않는다** — 알림 실패가 접수를 망가뜨리면 안 된다.
 * 신청자는 이미 다 적어서 보냈고, 우리 채널 사정은 그 사람 책임이 아니다.
 */
export async function notify(app: Application, at: Date): Promise<boolean> {
  const url = webhookUrl();
  if (!url) {
    console.warn("MATTERMOST_WEBHOOK_URL 미설정 — 신청 알림을 건너뛴다");
    return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: buildMessage(app, at) }),
    });
    if (res.ok) return true;

    const body = await res.text().catch(() => "");
    console.error(`Mattermost 신청 알림 실패 (${res.status})`, body);
    return false;
  } catch (e) {
    console.error("Mattermost 신청 알림 예외", e);
    return false;
  }
}
