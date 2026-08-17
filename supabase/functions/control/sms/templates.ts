/**
 * 손님에게 나가는 문자 문구 — **이 파일이 문구의 정본이다.**
 *
 * 어드민(`admin.html`)에도 같은 문구를 두지 않는다. 사람이 눌러 보내는 문자와 cron이 자동으로
 * 보내는 문자가 갈라지면, 손님에게 한 약속이 두 개가 된다. 어드민은 복사할 문구조차
 * 서버(`sms_preview`)에서 받아 쓴다 — 미리보기와 실제 발송이 다를 여지를 남기지 않기 위해서다.
 *
 * 원본은 `06-applications/_sms-templates.html`(형운 작성, 보증금 유무 2벌). 그쪽은 사람이 읽고
 * 고치는 시안이고, 실제로 나가는 것은 여기다. 문구를 바꾸면 **양쪽을 같이** 바꾼다.
 *
 * 네트워크도 DB도 없는 순수 함수만 둔다 — 그래서 문구 검증이 발송 없이 전부 돈다.
 */

import { targetTime } from "../automation/windows.ts";

/**
 * 문자 종류. 순서가 곧 손님이 받는 순서다.
 *
 * `deposit`은 보증금을 받는 예약에만 있다. `confirm`은 둘 다 있는데 문구가 갈린다 —
 * 보증금 예약은 "입금 확인되어 확정", 아니면 그냥 "확정".
 */
export type SmsKind = "deposit" | "confirm" | "checkin" | "checkout_soon" | "checkout";

export const SMS_KINDS: readonly SmsKind[] = [
  "deposit",
  "confirm",
  "checkin",
  "checkout_soon",
  "checkout",
] as const;

/** 어드민 화면과 알림에 쓰는 이름. 코드의 kind를 사람에게 그대로 보이지 않는다. */
export const KIND_LABEL: Record<SmsKind, string> = {
  deposit: "청소 보증금 안내",
  confirm: "예약 확정 안내",
  checkin: "입실 안내",
  checkout_soon: "퇴실 15분 전 안내",
  checkout: "퇴실 시간 안내",
};

/** 문구를 채우는 데 필요한 최소 필드. 예약 행 전체를 알 필요가 없다. */
export interface ReservationForSms {
  date: string; // 'YYYY-MM-DD' (KST)
  start_time: string; // 'HH:MM:SS' (KST)
  end_time: string;
  deposit_required: boolean;
}

/** 공간 사실. 주소·전화·안내 페이지는 여러 문구에 반복되므로 한 곳에서만 적는다. */
const ADDRESS = "서울 마포구 월드컵로3길 31-32, 3층 (합정역 8번 출구에서 도보로 5분 정도 걸려요)";
const CONTACT = "010-4810-9142";
const GUIDE_URL = "https://typelounge.vercel.app";

/**
 * 보증금 입금 계좌. **시크릿이 아니다** — 손님 전원에게 보내는 값이라 숨길 대상이 아니고,
 * 숨기면 오히려 문구가 두 곳으로 갈라진다. 시크릿으로 다루는 것은 이 레포 규칙대로
 * ThinQ PAT·service_role 키·웹훅 URL이다.
 */
const DEPOSIT_ACCOUNT = "카카오뱅크 3333171125623 (예금주: 이준용)";
const DEPOSIT_AMOUNT = "5만원";

/** 'YYYY-MM-DD' + 'HH:MM:SS' → '2026.08.10(월) 14:00–18:00'. 알림에서도 같은 표기를 쓴다. */
export function formatSlot(r: ReservationForSms): string {
  // 요일만 Date로 구한다. **timeZone을 반드시 넘긴다** — Edge Function 런타임은 UTC라
  // 그냥 getDay()를 쓰면 KST 00:00~09:00 예약이 전날 요일로 나온다(windows.ts의 같은 함정).
  const weekday = targetTime(r.date, r.start_time)
    .toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" });
  const date = r.date.replace(/-/g, ".");
  // 시각 문자열은 이미 KST 벽시계 값이라 그대로 자른다 — Date로 바꿀 이유가 없다.
  return `${date}(${weekday}) ${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`;
}

function depositMessage(): string {
  return [
    "[타입라운지] 안녕하세요, 예약 신청해주셔서 감사합니다 :)",
    "",
    `예약 확정을 위해 청소 보증금 ${DEPOSIT_AMOUNT} 입금 부탁드릴게요.`,
    `계좌: ${DEPOSIT_ACCOUNT}`,
    "",
    "입금 확인되면 예약이 확정됩니다. 청소 보증금은 정상 퇴실 확인 후 24시간 내로 반환해 드려요.",
    "",
    "궁금하신 점 있으시면 편하게 연락 주세요.",
    CONTACT,
  ].join("\n");
}

function confirmMessage(r: ReservationForSms): string {
  return [
    "[타입라운지] 안녕하세요, 예약해주셔서 감사합니다 :)",
    "",
    r.deposit_required ? "보증금 입금 확인되어 예약 확정되었습니다!" : "예약 확정되었습니다!",
    "",
    `예약 일시: ${formatSlot(r)}`,
    `주소: ${ADDRESS}`,
    "",
    "입실 10분 전에 이용 안내 문자 다시 보내드릴게요.",
    "",
    "편안하고 좋은 시간 보내시길 바라요. 감사합니다!",
  ].join("\n");
}

/**
 * `prevEndHm`은 앞 예약이 리드타임과 겹치게 끝나는 날에만 온다(`sms/schedule.ts`의
 * `precedingEndHm`). 그때만 "앞 타임 이용 중" 한 줄을 넣는다 — 앞 예약이 없는 날에
 * 넣으면 사실이 아니고, 항상 빼면 문자를 받고 바로 온 손님이 앞 손님 이용 중에 문을 연다
 * (형운 결정, 2026-08-18). 안내 페이지도 같은 겹침 동안 현관 비밀번호를 지연한다.
 */
function checkinMessage(prevEndHm: string | null): string {
  return [
    "[타입라운지] 안녕하세요, 곧 입실 시간이네요 :)",
    "",
    "10분 후 입실 가능하십니다. 오시는 길에 헤매지 않으시도록 다시 한 번 안내드려요.",
    ...(prevEndHm
      ? [
        "",
        `앞 타임에 이용 중인 분이 계셔서, 현관 비밀번호는 ${prevEndHm}부터 안내 페이지에 표시돼요. 입실 시간에 맞춰 들어와 주시면 감사하겠습니다 :)`,
      ]
      : []),
    "",
    `주소: ${ADDRESS}`,
    "",
    "찾아오는 길이랑 공간 이용하는 방법을 아래 페이지에 자세히 정리해뒀어요. 도착 전에 한 번 훑어보시면 편하게 이용하실 수 있을 거예요.",
    GUIDE_URL,
    "",
    "이용하시다 궁금하거나 불편한 점 있으면 편하게 연락 주세요.",
    CONTACT,
    "",
    "좋은 시간 보내세요!",
  ].join("\n");
}

/**
 * 마지막 줄의 **"바로 다음 시간에 예약하신 분이 계셔서"는 항상 넣는다**(형운 결정, 2026-08-08).
 *
 * 다음 예약이 없는 날에는 사실이 아니라는 점을 확인했고, 그럼에도 유지하기로 했다 —
 * 퇴실 지연 압박이 이 문장에 걸려 있기 때문이다. 조건부로 바꾸려면 예약 목록에서 같은 날
 * 이어지는 예약을 조회해 이 줄만 갈아끼우면 된다(`render`에 다음 예약 유무를 넘기는 형태).
 * 지우거나 되돌리기 전에 이 결정을 먼저 확인할 것.
 */
function checkoutSoonMessage(): string {
  return [
    "[타입라운지] 안녕하세요, 퇴실 안내 문자 드려요 :)",
    "",
    "퇴실 시간이 15분 남았어요! 남은 시간 편하게 마무리하시고, 나가시기 전에 아래 사항들 살펴봐 주시면 감사하겠습니다.",
    "",
    "- 가구랑 비품들은 원래 위치로 정리해주세요",
    "- 쓰레기는 문 밖 테라스 쓰레기통에 챙겨서 버려주시면 돼요",
    "- 영수증 등 개인정보가 담긴 종이는 꼭 찢어서 버려주세요 (미이행 시 과태료가 부과될 수 있어 꼭 부탁드려요)",
    "- 개인 소지품 두고 가시는 물건 없는지 한 번 확인해주세요",
    "- 냉난방기와 조명은 저희가 정리하니 별도로 끄지 않으셔도 돼요",
    "",
    "바로 다음 시간에 예약하신 분이 계셔서, 죄송하지만 퇴실 시간 꼭 맞춰주시면 정말 감사하겠습니다 🙏",
  ].join("\n");
}

/**
 * 퇴실 시각 **정각에 자동으로** 나가는 문자다. 그 시점에 손님이 실제로 나갔는지, 정리가 됐는지
 * 확인한 사람이 아무도 없다 — 그래서 "정상 퇴실 확인되었습니다"라고 쓰지 않는다(형운 결정, 2026-08-08).
 * 이 문자는 **퇴실 시각이 됐다는 알림**이고, 확인은 사람이 어드민에서 따로 표시한다.
 *
 * 보증금 문구도 같은 이유로 미래형이다. 조건은 `depositMessage`와 **같은 말**로 적는다 —
 * "정상 퇴실 확인 후". 두 문자가 반환 조건을 다르게 말하면 손님에게 한 약속이 두 개가 된다.
 */
function checkoutMessage(r: ReservationForSms): string {
  return [
    "[타입라운지] 안녕하세요, 퇴실 시간입니다 :)",
    "",
    "이용 시간이 종료되었어요. 정리 마치고 나가주시면 감사하겠습니다.",
    ...(r.deposit_required
      ? ["", "청소 보증금은 정상 퇴실 확인 후 24시간 내로 입금하신 계좌로 환불해 드릴게요."]
      : []),
    "",
    "혹시 이용하시고 사진 한 장 남기고 리뷰까지 써주시면, 다음에 예약하실 때 이용 시간을 더 챙겨드릴게요!",
    "",
    "오늘 이용해주셔서 감사해요. 다음에 또 편하게 찾아주세요!",
  ].join("\n");
}

/**
 * 이 예약에 실제로 나가는 문자들. 보증금을 안 받으면 `deposit`은 아예 없다.
 *
 * 어드민 화면도 자동 발송도 이 목록만 본다 — 한 곳에서 정하지 않으면 화면에는 보이는데
 * 자동으로는 안 나가는(또는 그 반대의) 종류가 생긴다.
 */
export function kindsFor(r: ReservationForSms): SmsKind[] {
  return SMS_KINDS.filter((k) => k !== "deposit" || r.deposit_required);
}

/**
 * 종류별 조건부 재료. 순수 함수 원칙을 지키려고 조회는 호출부(`dispatch.ts`의 `renderExtra`)가
 * 하고, 여기는 받은 값으로 문구만 만든다. **모든 render 호출부가 같은 재료를 넘겨야 한다** —
 * 한 곳이라도 빼먹으면 미리보기·장부·실발송의 문구가 갈라진다.
 */
export interface RenderExtra {
  /** checkin 전용 — 리드타임과 겹치게 끝나는 앞 예약의 종료 시각(KST "HH:MM"). */
  prevEndHm?: string | null;
}

/** 종류 + 예약 → 실제로 보낼 본문. */
export function render(kind: SmsKind, r: ReservationForSms, extra: RenderExtra = {}): string {
  switch (kind) {
    case "deposit":
      return depositMessage();
    case "confirm":
      return confirmMessage(r);
    case "checkin":
      return checkinMessage(extra.prevEndHm ?? null);
    case "checkout_soon":
      return checkoutSoonMessage();
    case "checkout":
      return checkoutMessage(r);
  }
}
