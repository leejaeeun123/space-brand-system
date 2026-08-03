# SpaceCloud 예약 자동 반영 (Gmail → Supabase)

`office@spacecloud.kr`에서 오는 "예약 완료"/"취소 완료" 메일을 감지해 `admin.html`이 쓰는
Supabase RPC(`admin_add_reservation` / `admin_set_cancelled`)로 자동 반영하는 Google Apps Script.

## 설치

1. https://script.google.com → 새 프로젝트 생성 (Gmail을 수신하는 계정, 즉 `nmwc.ai@gmail.com`으로 로그인한 상태에서).
2. `spacecloud-gmail-sync.gs` 내용을 통째로 붙여넣기.
3. 좌측 톱니바퀴(프로젝트 설정) → **스크립트 속성** → 속성 추가:
   - 키: `ADMIN_PASSWORD`
   - 값: `admin.html` 로그인에 쓰는 그 관리자 비밀번호
   - 키: `MATTERMOST_WEBHOOK_URL`
   - 값: `https://mm.nmwc.ai.kr/hooks/<웹훅 ID>` (Mattermost 알림용. 아래 "Mattermost 알림" 참고. 비워두면 알림만 조용히 생략되고 예약 처리는 정상 동작)
4. 함수 선택 드롭다운에서 `createTrigger` 선택 후 실행 → Gmail 권한 승인 팝업 승인.
   (15분마다 `processSpaceCloudReservations`를 도는 트리거가 1회 생성됨)
5. 확인: `processSpaceCloudReservations`를 수동으로 한 번 실행해보고 실행 로그(보기 → 실행 기록)에서 에러가 없는지 확인.

## 동작 방식

- 검색 쿼리: `from:office@spacecloud.kr subject:("예약 완료" OR "취소 완료") -label:spacecloud-processed -label:spacecloud-error`
- **예약 완료 메일**: 본문 표(예약공간·예약내용·예약인원·예약옵션·요청사항·예약자명·결제수단·결제금액)를 정규식으로 추출해 `admin_add_reservation` 호출.
  - "MY 예약 상세 페이지" 링크에서 예약번호(예: `10388381`)를 함께 추출해 `p_booking_no`로 저장.
  - `예약공간`(예: `[오픈특가]TYPE LOUNGE`)은 별도 컬럼이 없어 `p_memo`에 원문 그대로 저장.
- **취소 완료 메일**: 예약번호가 없어 (날짜, 시작/종료 시간)으로 기존 예약을 찾아 `admin_set_cancelled`로 **삭제가 아닌 상태 변경**만 수행 (`cancelled = true`). admin.html에는 "취소됨" 배지로 표시됨.
  - 일치하는 예약을 못 찾으면(예: 자동화 도입 전에 만들어진 예약) 에러로 처리 — 실패 알림 메일로 수동 확인 유도.
- 처리된 스레드는 `spacecloud-processed` 라벨을, 파싱/등록/취소 실패 시 `spacecloud-error` 라벨을 붙이고 실행 계정 메일로 실패 알림을 보냄 (재처리 대상에서 제외되므로 원인 해결 후 라벨을 수동으로 떼어내면 다음 실행 때 재시도됨).
- 중복 등록 방지: `LockService`로 동시 실행(수동 실행과 15분 트리거가 겹치는 경우 등)을 막고, 예약번호가 이미 등록돼 있으면 등록을 건너뜀. DB에도 `booking_no` unique index가 있어 이중 안전장치.

## Mattermost 알림

예약 등록 / 취소 반영 / 처리 실패가 발생하면 Mattermost `e-alert-typelounge` 채널로 알림을 보낸다.

- 발송 경로: Mattermost **인커밍 웹훅**. URL은 커밋하지 않고 스크립트 속성 `MATTERMOST_WEBHOOK_URL`로만 주입한다.
- 반드시 공개 주소(`https://mm.nmwc.ai.kr/hooks/...`)를 쓴다. Apps Script는 구글 서버에서 실행되므로 `localhost:8065`에 도달할 수 없다.
- 알림 시점은 각 RPC가 **성공한 뒤**다. 중복 예약으로 등록을 건너뛴 경우엔 알리지 않는다.
- **알림 실패는 예약 처리에 영향을 주지 않는다.** `notifyMattermost`는 모든 예외를 삼키고 로그만 남긴다. 이렇게 하지 않으면 Mattermost가 잠시 죽었을 때 정상 등록된 예약까지 `spacecloud-error` 라벨이 붙어 재처리 대상에서 빠진다.
- 서버가 맥에서 cloudflared 터널로 노출되므로, 맥이 잠들어 있으면 알림만 유실되고 예약 데이터는 정상 반영된다.
- 알림 지연은 최대 15분(트리거 주기)이다.
- 요청사항처럼 자유 입력 값에 `|`나 개행이 들어와도 표가 깨지지 않도록 무해화한다.

## 범위 / 제약

- 스페이스클라우드(`스클`) 메일만 처리. 네이버 예약 메일은 다루지 않음(추가 필요 시 `GMAIL_QUERY`와 파싱 함수를 확장).
- 취소는 (날짜+시작+종료 시간) 일치로만 찾음 — 같은 시간대에 동시 예약이 2건 이상 있는 경우는 가정하지 않음(단일 공간 운영이라 실질적으로 불가능).
- 인당/전화/이메일 등 이 메일에 없는 필드는 비워둠.
