/**
 * 지원금 신청 검증 — 단일 책임: 브라우저가 보낸 것을 저장해도 되는 값으로 바꾸거나, 거절한다.
 *
 * 순수 함수만 담는다. 암호화도 DB도 여기 없다(`crypto.ts`·`store.ts`) — 그래서 규칙 전체가
 * 키 없이 테스트된다.
 *
 * `apply/validate.ts`와 같은 태도지만 다루는 값의 등급이 다르다. 여기서 통과한 값은
 * **주민번호와 계좌번호**로 저장된다.
 */

/** 저장 직전 형태. 주민번호·계좌번호는 아직 평문이다 — 암호화는 store 직전에 한 번만 한다. */
export interface Claim {
  name: string;
  phone: string;
  email: string;
  bookingNo: string | null;
  usedOn: string;
  amount: number;
  bank: string;
  accountHolder: string;
  account: string;
  rrn: string;
  /** 리뷰를 남겼다고 확인했는가. 지급 조건이라 항상 true지만, 값을 들고 다니는 이유는 store가 시각을 찍기 위해서다. */
  reviewDone: true;
}

export type Validated =
  | { ok: true; value: Claim }
  | { ok: true; spam: true }
  | { ok: false; error: string };

const LIMITS = {
  name: 40,
  phone: 30,
  email: 120,
  bookingNo: 40,
  bank: 30,
  accountHolder: 40,
  account: 30,
} as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 주민등록번호 형식. **검증은 자릿수와 생년월일·성별코드까지만 한다.**
 *
 * 흔히 쓰는 '주민번호 체크섬'을 여기서 쓰면 안 된다 — 2020-10-06 이후 발급분은 뒷자리
 * 6개가 임의 부여로 바뀌어 검증식이 성립하지 않는다. 체크섬을 넣으면 **정상적으로 발급된
 * 최근 번호를 우리가 거절**하게 되고, 신청자는 자기 번호가 왜 안 되는지 알 길이 없다.
 */
const RRN = /^(\d{6})-?([1-8])(\d{6})$/;

/** 이용일. 미래 날짜와 터무니없이 오래된 날짜만 거른다. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 청구 금액 상한. 이 공간의 하루 최대 이용료를 크게 웃도는 값이라, 넘으면 오타이거나 장난이다. */
const MAX_AMOUNT = 10_000_000;

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 숫자만 남긴다. 계좌번호는 하이픈을 넣는 사람과 안 넣는 사람이 반반이다. */
function digits(v: string): string {
  return v.replace(/\D/g, "");
}

/** 생년월일이 말이 되는가. 성별코드로 세기를 가른다(1·2=1900년대, 3·4=2000년대, 5~8=외국인). */
function birthOk(six: string, gender: string): boolean {
  const yy = Number(six.slice(0, 2));
  const mm = Number(six.slice(2, 4));
  const dd = Number(six.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;

  const century = ["1", "2", "5", "6"].includes(gender) ? 1900 : 2000;
  const year = century + yy;
  const d = new Date(Date.UTC(year, mm - 1, dd));
  // 2월 30일 같은 값은 Date가 다음 달로 넘겨버린다 — 되돌아오는지로 판정한다.
  return d.getUTCFullYear() === year && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd;
}

/** '990101-1234567' → '990101-*******'. 어드민 목록이 읽는 유일한 형태다. */
export function maskRrn(rrn: string): string {
  const m = RRN.exec(rrn);
  if (!m) return "******-*******";
  return `${m[1]}-*******`;
}

/** '1234567890' → '******7890'. 뒤 4자리는 남긴다 — 사람이 계좌를 대조할 때 그것만 본다. */
export function maskAccount(account: string): string {
  const d = digits(account);
  if (d.length <= 4) return "*".repeat(d.length);
  return "*".repeat(d.length - 4) + d.slice(-4);
}

export function validate(body: Record<string, unknown>): Validated {
  if (text(body.website) !== "") return { ok: true, spam: true };

  const name = text(body.name);
  const phone = text(body.phone);
  const email = text(body.email);
  const bookingNo = text(body.bookingNo);
  const usedOn = text(body.usedOn);
  const bank = text(body.bank);
  const accountHolder = text(body.accountHolder);
  const account = digits(text(body.account));
  // 주민번호는 하이픈 유무를 신경 쓰지 않고 받되, 저장은 하이픈 있는 한 형태로 통일한다.
  const rrnDigits = digits(text(body.rrn));

  if (body.consent !== true) {
    return { ok: false, error: "개인정보 수집·이용에 동의해 주세요" };
  }

  // 리뷰 확인도 서버가 자른다. 체크박스는 화면 장치라 `fetch`로는 그냥 빠진다 —
  // 동의를 `=== true`로 보는 것과 같은 이유다(문자열 "false"도 truthy다).
  if (body.reviewDone !== true) {
    return { ok: false, error: "리뷰를 남기셨는지 확인해 주세요" };
  }

  if (!name) return { ok: false, error: "이름을 입력해 주세요" };
  if (!phone) return { ok: false, error: "연락처를 입력해 주세요" };
  if ((phone.match(/\d/g) ?? []).length < 9) {
    return { ok: false, error: "연락처를 다시 확인해 주세요" };
  }
  if (!email) return { ok: false, error: "이메일을 입력해 주세요" };
  if (!EMAIL.test(email)) return { ok: false, error: "이메일 형식을 다시 확인해 주세요" };

  if (!DATE.test(usedOn)) return { ok: false, error: "이용일을 선택해 주세요" };
  const used = new Date(`${usedOn}T00:00:00+09:00`);
  if (Number.isNaN(used.getTime())) return { ok: false, error: "이용일을 다시 확인해 주세요" };
  // 아직 오지 않은 이용은 청구할 수 없다. 하루치 여유를 두는 이유는 KST와 서버 시각 차이 때문이다.
  if (used.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    return { ok: false, error: "이용일이 아직 오지 않았어요" };
  }

  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: "이용 금액을 숫자로 입력해 주세요" };
  }
  if (amount > MAX_AMOUNT) return { ok: false, error: "이용 금액을 다시 확인해 주세요" };

  if (!bank) return { ok: false, error: "은행을 입력해 주세요" };
  if (!accountHolder) return { ok: false, error: "예금주를 입력해 주세요" };
  // 국내 계좌번호는 10~14자리가 대부분이다. 넉넉히 잡되 명백한 오타는 거른다.
  if (account.length < 8 || account.length > 20) {
    return { ok: false, error: "계좌번호를 다시 확인해 주세요" };
  }

  const m = RRN.exec(rrnDigits.length === 13 ? rrnDigits : text(body.rrn));
  if (!m || !birthOk(m[1], m[2])) {
    return { ok: false, error: "주민등록번호를 다시 확인해 주세요" };
  }
  const rrn = `${m[1]}-${m[2]}${m[3]}`;

  for (const [key, max] of Object.entries(LIMITS)) {
    const value = { name, phone, email, bookingNo, bank, accountHolder, account }[
      key as keyof typeof LIMITS
    ];
    if (value.length > max) return { ok: false, error: `입력이 너무 깁니다 (${max}자 이내)` };
  }

  return {
    ok: true,
    value: {
      name,
      phone,
      email,
      bookingNo: bookingNo || null,
      usedOn,
      amount,
      bank,
      accountHolder,
      account,
      rrn,
      reviewDone: true,
    },
  };
}
