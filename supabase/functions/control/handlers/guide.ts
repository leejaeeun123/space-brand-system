/**
 * 이용 안내 페이지가 예약 시간에만 받아 가는 값 — 현관 비밀번호와 와이파이.
 *
 * **왜 서버에 있나.** `guest-guide.html`은 소스가 그대로 공개되는 정적 페이지다. 값을 HTML에
 * 두고 JS로 감추면 '열림/닫힘'은 화면에만 있고 값은 누구나 소스 보기로 읽는다 — auth.ts가
 * 손님 권한을 서버에서 자르는 것과 같은 이유로, 시간 게이트도 **값을 안 내려주는 것**이어야
 * 실제 방어가 된다. 클라이언트에서 감추는 건 방어가 아니다.
 *
 * **시크릿으로 다루지 않는 이유**는 이 레포가 이미 정한 선과 같다(`sms/templates.ts`의
 * 보증금 계좌 주석). 손님 전원에게 알려주는 값은 숨길 대상이 아니고, 환경변수로 옮기면
 * 값이 repo 밖으로 나가 바꿀 때마다 시크릿 설정과 배포가 짝을 맞춰야 한다 — 한쪽이 뒤처지면
 * 손님이 빈 칸을 본다. 시크릿으로 다루는 것은 ThinQ PAT·service_role 키·웹훅 URL이다.
 *
 * 그래서 여기 있는 값의 성격은 "비밀"이 아니라 **"예약한 사람에게만, 예약 시간에만 준다"**다.
 * 게이트는 `reservation-window.ts`의 `guideGate`가 하고(입실 10분 전~퇴실), 이 파일은
 * 통과한 요청에 값을 돌려주는 일만 한다. 예외 하나 — 예약이 연달아 붙은 날의 리드타임에는
 * 현관 비밀번호만 판정 결과에 따라 뺀다(아래 `guide()` 참고).
 *
 * ⚠️ **현관 비밀번호를 바꾸면 여기와 실제 도어락 두 곳을 함께 바꾼다.** 한쪽만 바꾸면
 * 손님이 문 앞에서 못 들어오고, 그 사실은 손님이 전화할 때까지 아무 로그에도 안 남는다.
 */

/**
 * 현관 도어락 비밀번호. 실제 기기에 심긴 값과 같아야 한다.
 *
 * **export 하는 이유**는 청소 담당자 아침 문자도 이 값을 싣기 때문이다
 * (`cleaning/templates.ts`). 담당자도 문을 열고 들어와야 하는데, 청소 시간은 예약 구간
 * 밖이라 이 페이지가 닫혀 있어 스스로 확인할 방법이 없다. 값을 두 곳에 적으면 비밀번호를
 * 바꿀 때 한쪽만 고쳐져, 담당자가 문 앞에서 못 들어오는 것이 아무 로그에도 안 남는다.
 */
export const DOOR_PIN = "1010123";

/** 와이파이 접속 정보. SSID는 공개돼 있고(전파로 보인다) 비밀번호만 게이트 뒤에 있다. */
const WIFI_SSID = "TYPE LOUNGE";
const WIFI_PASSWORD = "075C62183A";

export interface GuideSecrets {
  /** 앞 예약이 아직 이용 중인 리드타임에는 null — 그때 `door_pin_available_at`이 대신 온다. */
  door_pin: string | null;
  /** 비밀번호가 열리는 시각(KST "HH:MM"). door_pin이 null일 때만 값이 있다. */
  door_pin_available_at: string | null;
  wifi_ssid: string;
  wifi_password: string;
}

/**
 * 게이트를 통과한 요청에 안내 값을 돌려준다.
 *
 * DB를 보지 않는다 — 값이 예약마다 다르지 않기 때문이다. 예약별로 달라지는 것(이름·시각)은
 * 손님 화면에 필요 없고, 그건 `admin_*` RPC 뒤에 있어야 하는 개인정보다.
 *
 * **현관 비밀번호만 게이트 판정에 따라 뺀다.** 예약이 연달아 붙은 날의 리드타임(입실 10분 전~
 * 시작)은 앞 손님의 마지막 10분이라, 그때 비밀번호를 내려주면 다음 손님이 앞 손님 이용 중에
 * 문을 열 수 있다(형운 결정, 2026-08-18 — 근거는 `reservation-window.ts`의 `GuideGate`).
 * 와이파이는 그대로 둔다 — 입장 권한이 아니고, 문 앞에서 미리 붙어 있어야 편하다.
 * `gate`가 없으면(어드민 호출) 전부 내려준다.
 */
export function guide(gate?: { pinWithheld: boolean; pinAvailableAtKst: string | null } | null): GuideSecrets {
  const withheld = gate?.pinWithheld ?? false;
  return {
    door_pin: withheld ? null : DOOR_PIN,
    door_pin_available_at: withheld ? (gate?.pinAvailableAtKst ?? null) : null,
    wifi_ssid: WIFI_SSID,
    wifi_password: WIFI_PASSWORD,
  };
}
