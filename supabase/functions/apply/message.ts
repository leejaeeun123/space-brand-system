/**
 * 알림 메시지 조립 — 단일 책임: 신청 한 건을 채널에서 읽히는 한 통으로 만든다.
 *
 * 발송(`notify.ts`)과 나눠 둔 이유는 여기가 순수 함수만 담기 때문이다 — 웹훅 없이 테스트가
 * 전부 돈다(`message.test.ts`). 형식은 기존 알림(`control/automation/message.ts`,
 * `spacecloud-gmail-sync.gs`)과 같은 `**제목** · 시각` + 마크다운 표다.
 */

import type { Application } from "./validate.ts";

const KST = { timeZone: "Asia/Seoul", hour12: false } as const;

/** '2026. 08. 10. 14:32' — 다른 알림과 같은 모양으로 찍는다. */
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

/**
 * 표 칸 안전화.
 *
 * `|`는 칸을 쪼개고 줄바꿈은 표를 통째로 끝낸다 — 신청자가 친 글자가 알림의 **구조**를 바꾸면
 * 안 된다. 이건 미용이 아니라, 남이 쓴 문자열을 우리 형식 안에 넣을 때의 최소 방어다.
 */
function cell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\s*\r?\n\s*/g, " ");
}

/** 링크로 만들어도 안전한 핸들인가. 아니면 그냥 글자로 둔다 — 링크 문법이 깨지는 것보다 낫다. */
const SAFE_HANDLE = /^[A-Za-z0-9._]+$/;

function instagramCell(handle: string | null): string {
  if (!handle) return "—";
  if (!SAFE_HANDLE.test(handle)) return cell(handle);
  return `[@${handle}](https://instagram.com/${handle})`;
}

export function buildMessage(app: Application, at: Date): string {
  const rows = [
    `| 이름 | ${cell(app.name)} |`,
    `| 연락처 | ${cell(app.phone)} |`,
    `| 이메일 | ${cell(app.email)} |`,
    `| 인스타그램 | ${instagramCell(app.instagram)} |`,
  ];

  // **활용 목적만 표 밖에 둔다.** 자유 서술이라 여러 줄이 오는데, 표 칸에 밀어 넣으면 줄바꿈이
  // 사라져 한 덩어리로 읽힌다. 인용 블록은 줄을 그대로 살리면서 신청자의 글과 우리 형식을
  // 눈으로 구분해준다.
  const quoted = app.purpose.split(/\r?\n/).map((line) => `> ${line}`).join("\n");

  return [
    `**공간 지원 프로그램 신청** · ${stamp(at)}`,
    "",
    "| 항목 | 내용 |",
    "|---|---|",
    ...rows,
    "",
    "**활용 목적**",
    quoted,
  ].join("\n");
}
