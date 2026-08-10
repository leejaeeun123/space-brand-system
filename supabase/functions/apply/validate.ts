/**
 * 신청 입력 검증 — 단일 책임: 브라우저가 보낸 것을 저장해도 되는 값으로 바꾸거나, 거절한다.
 *
 * 순수 함수만 담는다. 네트워크도 DB도 없어 테스트가 전부 로컬에서 돈다(`validate.test.ts`).
 *
 * **클라이언트 검증(`required`·`type=email`)은 검증이 아니다.** `apply.html`은 소스가 그대로
 * 공개되고, 누구나 `fetch`로 이 함수를 직접 부를 수 있다. 여기서 통과한 것만 DB에 들어간다.
 */

/** 저장 가능한 형태로 정리된 신청. */
export interface Application {
  name: string;
  phone: string;
  email: string;
  /** 핸들만. 안 적었으면 null — 계정이 없어도 신청할 수 있다. */
  instagram: string | null;
  purpose: string;
}

export type Validated =
  | { ok: true; value: Application }
  /** 스팸으로 판정. 저장도 알림도 하지 않지만 **신청자에게는 성공으로 답한다**(index.ts). */
  | { ok: true; spam: true }
  | { ok: false; error: string };

/**
 * 칸별 길이 상한.
 *
 * DB 위생만을 위한 값이 아니다 — `purpose`의 1000자가 **Mattermost 4000자 상한을 지키는
 * 실질적인 장치**다. 알림 한 통에 신청 하나가 통째로 들어가므로, 여기를 열어두면 긴 신청
 * 하나가 거절당해 알림만 조용히 사라진다(`control/automation/message.ts`가 같은 함정을
 * 잘라내기로 해결한 그 상한이다).
 */
const LIMITS = { name: 40, phone: 30, email: 120, instagram: 60, purpose: 1000 } as const;

/** 이메일은 '@ 앞뒤가 있고 점이 있다'까지만 본다. 그 이상은 오탈자를 못 잡으면서 정상 주소만 막는다. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 인스타그램 핸들만 남긴다 — 사람들은 `@handle`도 프로필 URL도 그대로 붙여넣는다.
 *
 * 정리해 두면 알림에 뜨는 모양이 항상 같고, 나중에 신청자를 찾을 때 값을 손질할 필요가 없다.
 */
export function normalizeInstagram(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?instagram\.com\//i, "")
    .split(/[?#]/)[0]
    .replace(/^@/, "")
    .replace(/\/+$/, "")
    .trim();
}

/** 숫자만 세서 전화번호인지 본다. 국내외 표기가 제각각이라 형식을 강제하지 않는다. */
function looksLikePhone(v: string): boolean {
  return (v.match(/\d/g) ?? []).length >= 9;
}

export function validate(body: Record<string, unknown>): Validated {
  // 스팸 덫. 화면에 안 보이는 칸이라 사람은 절대 못 채운다 — 채워져 있으면 자동 제출이다.
  // 검증보다 먼저 보는 이유는, 봇이 다른 칸을 엉망으로 채웠어도 400을 돌려주면 덫이 있다는
  // 사실만 알려주는 꼴이기 때문이다.
  if (text(body.website) !== "") return { ok: true, spam: true };

  const name = text(body.name);
  const phone = text(body.phone);
  const email = text(body.email);
  const purpose = text(body.purpose);
  const instagram = normalizeInstagram(text(body.instagram));

  // **동의를 서버가 확인한다.** 체크박스는 화면 장치일 뿐이라 fetch로는 그냥 빠진다.
  // 동의 없이 들어온 개인정보는 저장하면 안 되는 값이다.
  if (body.consent !== true) {
    return { ok: false, error: "개인정보 수집·이용에 동의해 주세요" };
  }

  if (!name) return { ok: false, error: "이름을 입력해 주세요" };
  if (!phone) return { ok: false, error: "연락처를 입력해 주세요" };
  if (!looksLikePhone(phone)) return { ok: false, error: "연락처를 다시 확인해 주세요" };
  if (!email) return { ok: false, error: "이메일을 입력해 주세요" };
  if (!EMAIL.test(email)) return { ok: false, error: "이메일 형식을 다시 확인해 주세요" };
  if (!purpose) return { ok: false, error: "활용 목적을 입력해 주세요" };

  // 길이는 **자르지 않고 거절한다.** 조용히 잘라 저장하면 신청자는 다 보냈다고 믿는데
  // 우리는 잘린 것을 읽게 되고, 잘렸다는 사실은 아무 데도 안 남는다.
  for (const [key, max] of Object.entries(LIMITS)) {
    const value = { name, phone, email, instagram, purpose }[key as keyof typeof LIMITS];
    if (value.length > max) {
      return { ok: false, error: `입력이 너무 깁니다 (${max}자 이내)` };
    }
  }

  return {
    ok: true,
    value: { name, phone, email, instagram: instagram || null, purpose },
  };
}
