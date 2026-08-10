/**
 * 지원금 신청 알림 — 단일 책임: 접수 사실을 알리고, 갔는지만 돌려준다.
 *
 * ⚠️ **주민번호·계좌번호는 절대 넣지 않는다.**
 *
 * `apply/`의 알림은 신청 내용을 통째로 채널에 실어 보낸다. 여기서 그걸 그대로 따라 하면
 * 안 된다 — Mattermost 메시지는 검색되고, 전달되고, 알림으로 잠금화면에 뜨고, 우리가 정한
 * 파기 시점과 무관하게 채널에 영원히 남는다. 암호화해서 DB에 넣어 놓고 같은 값을 평문으로
 * 채널에 뿌리면 §24-2③을 지킨 의미가 없다.
 *
 * 그래서 채널이 받는 것은 **"누가 얼마를 청구했다"까지**다. 나머지는 어드민에서 본다.
 */

import type { Claim } from "./validate.ts";

function webhookUrl(): string | null {
  return Deno.env.get("MATTERMOST_APPLY_WEBHOOK_URL") ??
    Deno.env.get("MATTERMOST_WEBHOOK_URL") ?? null;
}

const KST = { timeZone: "Asia/Seoul", hour12: false } as const;

function stamp(at: Date): string {
  return at.toLocaleString("ko-KR", {
    ...KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 표 칸 안전화 — 신청자가 친 글자가 알림의 구조를 바꾸면 안 된다. */
function cell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\s*\r?\n\s*/g, " ");
}

/** 3.3% 원천징수 후 예상 지급액. 실제 지급은 사람이 확정하므로 어디까지나 참고값이다. */
export function netAmount(amount: number): { tax: number; net: number } {
  const tax = Math.floor(amount * 0.033);
  return { tax, net: amount - tax };
}

export function buildMessage(c: Claim, at: Date): string {
  const { tax, net } = netAmount(c.amount);
  const won = (n: number) => n.toLocaleString("ko-KR") + "원";

  return [
    `**지원금 신청 접수** · ${stamp(at)}`,
    "",
    "| 항목 | 내용 |",
    "|---|---|",
    `| 신청자 | ${cell(c.name)} |`,
    `| 이용일 | ${c.usedOn} |`,
    `| 예약번호 | ${c.bookingNo ? cell(c.bookingNo) : "—"} |`,
    `| 청구 금액 | ${won(c.amount)} |`,
    `| 원천징수 3.3% | ${won(tax)} |`,
    `| 예상 지급액 | **${won(net)}** |`,
    // 신청자의 자기보고다. 실제 리뷰는 사람이 판매 채널에서 대조해야 하므로,
    // '확인됨'이 아니라 '남겼다고 함'으로 적는다 — 둘을 같은 말로 쓰면 대조를 건너뛰게 된다.
    `| 리뷰 | 신청자가 남겼다고 확인 |`,
    "",
    // 이 줄이 곧 '왜 여기 계좌가 없는가'에 대한 답이다. 지우면 다음 사람이 친절하게 추가한다.
    "계좌·주민번호는 알림에 담지 않습니다 — 어드민 **지원금 신청** 탭에서 확인하세요.",
  ].join("\n");
}

/** 발송. 어떤 예외도 밖으로 던지지 않는다 — 알림 실패가 접수를 망가뜨리면 안 된다. */
export async function notify(c: Claim, at: Date): Promise<boolean> {
  const url = webhookUrl();
  if (!url) {
    console.warn("MATTERMOST_WEBHOOK_URL 미설정 — 지원금 신청 알림을 건너뜁니다");
    return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: buildMessage(c, at) }),
    });
    if (res.ok) return true;

    const body = await res.text().catch(() => "");
    console.error(`Mattermost 지원금 알림 실패 (${res.status})`, body);
    return false;
  } catch (e) {
    console.error("Mattermost 지원금 알림 예외", e);
    return false;
  }
}
