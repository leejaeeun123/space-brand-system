# spec_payback_claim

> 공간 지원 프로그램 참여자가 이용 비용을 청구하고(`/payback`), 운영자가 어드민 **지원금 신청** 탭에서
> 열람·지급·반려·파기를 처리하는 기능. 이 레포에서 가장 민감한 값 — 주민등록번호와 계좌번호 — 을 다룬다.

## 1. 개요

공간 지원 프로그램에 선정된 사람이 실제로 쓴 이용 비용을 청구하면, 운영자가 확인해 3.3%를
원천징수한 금액을 계좌로 보낸다. 지급을 마치면 어드민에서 **지급 완료**를 눌러 표시하고,
지급하지 않기로 하면 **반려**를 눌러 그 즉시 주민번호·계좌 암호문을 파기한다.

기능 전체가 하나의 제약에서 설계됐다 — **주민번호를 평문으로 어디에도 두지 않는다.**

- 수집 근거는 **동의가 아니라 소득세법**이다. 지원금은 사업소득이라 3.3%를 원천징수하고,
  원천징수 신고에는 지급명세서가 필요하며 거기 주민번호가 들어간다. 「개인정보 보호법」 §24-2는
  주민번호를 동의로 수집하는 것을 원칙적으로 금지하므로, 신청 페이지의 고지도 "동의해 주세요"가
  아니라 **"법령에 따라 받습니다"**로 쓰여 있다.
- 같은 조 ③항이 **암호화 저장을 강행 규정**으로 둔다. 그래서 암호화는 선택 사항이 아니고,
  "동의를 받았으니 평문으로 둬도 된다"는 성립하지 않는다.
- 암호화는 **DB가 아니라 Edge Function이** 한다. pgcrypto를 쓰면 키가 SQL 문에 실려 쿼리 로그·
  에러 메시지에 남을 수 있다. 이 구조에서 DB는 열 수 없는 바이트만 받는다 —
  **데이터베이스가 통째로 새도 주민번호는 안 새는 것**이 목적이다.

네 가지 동작(action)으로 이뤄진다.

| action | 누가 | 하는 일 |
| --- | --- | --- |
| `submit` | 공개 (`/payback`) | 검증 → 암호화 → 저장 → Mattermost 알림. 비밀번호 없음 |
| `reveal` | 어드민 | 한 건의 주민번호·계좌를 복호화해 돌려주고, 연 사실을 로그에 남긴다 |
| `mark_paid` | 어드민 | 지급 완료 표시(`paid_at`). **파기 시점이 여기 매달려 있다** |
| `reject` | 어드민 | 반려 + **암호문 즉시 파기** |

`apply`(공간 지원 신청) 함수와 합치지 않았다. 저기는 공개 액션 하나뿐이라 인증이라는 개념 자체가
없는데, 거기에 어드민 전용 복호화를 얹으면 실수 하나가 공개 경로에서 주민번호를 여는 사고가 된다.
`control`에 넣지 않은 이유도 같다 — 거기 guest 경로는 예약 시간 안에서만 열리는데 지원금 청구는
아무 때나 들어와야 한다.

## 기술 스택

프로젝트 공통(정적 HTML + Supabase) + 이 스펙 고유:

- **Supabase Edge Function** (Deno) — `supabase/functions/claim/`. 단일 함수, action 라우팅.
- **WebCrypto `crypto.subtle`** — AES-GCM 256bit. 외부 암호화 라이브러리를 쓰지 않는다(런타임 내장).
- **`jsr:@supabase/supabase-js@2`** — service_role 키로 `payback_claims` 접근.
- **PostgreSQL + `pg_cron`** — 보유기간 경과 건의 암호문 파기, 열람 로그 파기.
- **PostgreSQL `security definer` 함수** — `admin_list_paybacks(p_password text)`.
- **Mattermost incoming webhook** — 접수 알림(항목 최소화).
- **바닐라 JS + Paperlogy** — `payback.html`·`admin.html`. 빌드 단계·프레임워크 없음.
- **`jsr:@std/assert@1`** — `deno test`용.

## 실행 환경

| 구성 요소 | 환경 |
| --- | --- |
| 신청 페이지 `/payback` | 브라우저(모바일 우선). Vercel 정적 배포, `cleanUrls: true`, `public/`은 `06-applications/` 심링크 |
| 어드민 탭 | 브라우저(데스크톱 우선). 같은 배포의 `/admin` |
| `claim` 함수 | Supabase Edge Runtime (Deno). `supabase functions deploy claim` |
| DB·크론 | Supabase PostgreSQL. `supabase db push` |
| 테스트 | `deno test --allow-env supabase/functions/claim/` — 키도 DB도 필요 없다(순수 함수만 검사) |

보안 헤더는 `vercel.json`이 전 경로에 건다 — CSP·HSTS·`Referrer-Policy: no-referrer`·`X-Frame-Options: DENY`.
`no-referrer`는 이 기능에서 특히 의미가 있다: 신청 실패 후 어떤 이동이 일어나도 입력값이
리퍼러로 새지 않는다.

### 라우팅

```
public/  (06-applications/ 심링크)
├── payback.html     → /payback   공개
└── admin.html       → /admin     어드민 (지원금 신청 탭 = view-paybacks)

supabase/functions/
└── claim/           → POST /functions/v1/claim   (action으로 분기)
```

## 2. 접근 제어

**한 함수 안에 등급이 다른 두 경로가 있다.** 그래서 인증 문이 액션 분기 중간에 서 있다.

```
POST /functions/v1/claim
  action === 'submit'  → 공개. 비밀번호 없음. 여기서 응답하고 끝난다
  그 외                → 시도 제한 확인(clientIp) → 429
                       → ADMIN_PASSWORD 비교(constantTimeEqual) → 실패 시 기록 후 401
                       → id 검증 → reveal / mark_paid / reject
```

- **`ADMIN_PASSWORD` 미설정이면 전면 거부(503)** 한다. 비밀번호가 없는 상태가 '누구나 주민번호를
  열 수 있다'로 해석되면 안 된다.
- 시도 제한이 **비밀번호 비교보다 먼저** 온다. 이 문 뒤가 `reveal` — 주민번호를 평문으로 꺼내는
  유일한 경로라, 비밀번호를 던져볼 수 있는 횟수 자체를 자른다. 공개 접수 경로는 그 위에서 이미
  끝나므로 신청자는 영향받지 않는다. 시도 제한 키(`cf-connecting-ip`)·저장소·해제 규칙은
  `spec_admin_auth` 참조.
- 목록 조회 RPC `admin_list_paybacks`는 비밀번호 검증을 **`admin_list_reservations`에 위임**한다.
  `admin_list_sms`·`admin_list_applications`와 같은 방식이라, 비밀번호가 바뀔 때 고칠 곳이
  한 군데로 유지된다.
- `payback_claims`·`payback_reveal_log` 둘 다 **RLS on + 정책 0개**다. 신청 페이지는 anon 키를
  소스에 그대로 박고 배포되므로, 정책을 하나라도 열면 그 키로 암호문과 신청자 전원의 연락처를
  긁어갈 수 있다. 정책 없음 = service_role(Edge Function·RPC)만 닿는다.

## 3. 페이지 구성

### 3-1. 신청 페이지 `/payback`

```
┌───────────────────────────────┐
│  TYPE LOUNGE — 지원금 신청     │
│  ┌─────────────────────────┐  │
│  │ 안내 (3.3% 공제 후 지급)│  │
│  └─────────────────────────┘  │
│  신청자                        │
│   이름* / 연락처* / 이메일*   │
│  이용 내역                     │
│   이용일* / 예약번호(선택)     │
│   이용 금액*                   │
│  ┌─────────────────────────┐  │
│  │ 청구 금액   50,000원     │  │
│  │ 원천징수 3.3% − 1,650원 │  │  ← 금액 입력 시에만 표시
│  │ 예상 지급액  48,350원    │  │
│  └─────────────────────────┘  │
│  [v] 이용 후 리뷰를 남겼습니다 │
│  받으실 계좌                   │
│   은행* / 예금주*              │
│   계좌번호*                    │
│   주민등록번호*                │
│  ┌─────────────────────────┐  │
│  │ 주민번호를 받는 이유     │  │  ← 동의가 아니라 법령 고지
│  └─────────────────────────┘  │
│  (숨은 스팸 덫 칸)             │
│  ┌─────────────────────────┐  │
│  │ 개인정보 수집·이용 동의  │  │  ← 주민번호는 여기 포함 안 됨
│  │ [v] 위 내용에 동의합니다 │  │
│  └─────────────────────────┘  │
│  [ 지원금 신청하기 ]           │
│  (오류 문구)                   │
└───────────────────────────────┘
        ↓ 제출 성공
┌───────────────────────────────┐
│  ✓ 신청이 접수됐어요           │  ← 폼은 reset 후 display:none
└───────────────────────────────┘
```

### 3-2. 어드민 **지원금 신청** 탭

```
┌──────────────────────────────────────────────┐
│  지원금 신청                                  │
│  (알림 영역 — 실패 사유가 여기 뜬다)          │
│  ┌────────────────────────────────────────┐  │
│  │ 홍길동  [지급완료] [알림 못 감] [파기됨]│  │
│  │ 2026-08-10 14:20 접수 · … 지급          │  │
│  │  이용일    2026-08-09                   │  │
│  │  예약번호  —                            │  │
│  │  청구 금액 50,000원                     │  │
│  │  지급 예정 48,350원 (3.3% 1,650원 공제) │  │
│  │  리뷰      남겼다고 확인함              │  │
│  │  연락처 / 이메일 / 예금주               │  │
│  │  계좌      ******7890                   │  │
│  │  주민번호  990101-*******               │  │
│  │  [주민번호·계좌 보기] [지급 완료] [반려]│  │
│  └────────────────────────────────────────┘  │
│  [ 새로고침 ]                                 │
│  ┌────────────────────────────────────────┐  │
│  │ ⚠ 경고문 — 암호화 보관 / 확인 후 바로  │  │
│  │   숨기기 / 지급 후 '지급 완료' 필수     │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

## 4. 섹션별 상세

### 4-1. 청구 폼 — 입력과 검증

**기능**: 신청 값을 받아 `claim` 함수에 `action: 'submit'`으로 보낸다.

**UI 규칙 (이 페이지가 지켜야 할 것)**

- `localStorage`·`sessionStorage`에 입력값을 저장하지 않는다. 임시저장 기능을 넣지 말 것.
- 주민번호·계좌번호·은행·예금주 칸은 `autocomplete="off"`. 켜두면 브라우저 자동완성 저장소에
  주민번호가 남는다.
- 실패해도 입력을 URL·쿼리에 싣지 않는다.
- 금액 칸은 입력 중 천 단위 구분을 넣는다 — 0의 개수를 눈으로 세다 생기는 실수를 막는다.
- 주민번호 칸은 6자리에서 하이픈을 자동으로 넣는다(형식이 보여야 자릿수 실수를 알아챈다).
- **제출 성공 후 `form.reset()` + `display:none`.** 성공한 뒤에도 주민번호가 화면에 남으면
  카페에서 신청한 사람의 화면이나 나중에 찍힌 스크린샷에 그대로 들어간다.
- 클라이언트 검증(`firstLocalProblem`)은 **왕복 절약용일 뿐 검증이 아니다.** 소스가 공개되므로
  누구나 `fetch`로 함수를 직접 부를 수 있다. 판정은 전부 서버(`validate.ts`)에 있다.

**서버 검증 규칙** (`validate.ts` — 순수 함수, 키도 DB도 없이 테스트된다)

| 항목 | 규칙 | 거절 문구 |
| --- | --- | --- |
| `website` (허니팟) | 비어 있지 않으면 **저장·알림 없이 200 `{ok:true}`** | (없음 — 봇에게 실패를 알려주지 않는다) |
| `consent` | `=== true`만 인정. 문자열 `"false"`도 truthy라 값 비교를 쓴다 | 개인정보 수집·이용에 동의해 주세요 |
| `reviewDone` | `=== true`. 체크박스는 `fetch`로 그냥 빠지므로 서버가 자른다 | 리뷰를 남기셨는지 확인해 주세요 |
| `name` | 필수 · 40자 이내 | 이름을 입력해 주세요 |
| `phone` | 필수 · 숫자 9개 이상 · 30자 이내 | 연락처를 다시 확인해 주세요 |
| `email` | 필수 · `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` · 120자 이내 | 이메일 형식을 다시 확인해 주세요 |
| `usedOn` | `YYYY-MM-DD` · KST 해석 · **미래 이용일 거절**(`now + 24h` 여유) | 이용일이 아직 오지 않았어요 |
| `amount` | 정수 · `> 0` · **≤ 10,000,000** | 이용 금액을 다시 확인해 주세요 |
| `bank` | 필수 · 30자 이내 | 은행을 입력해 주세요 |
| `accountHolder` | 필수 · 40자 이내 | 예금주를 입력해 주세요 |
| `account` | 숫자만 남긴 뒤 **8~20자리** · 원문 30자 이내 | 계좌번호를 다시 확인해 주세요 |
| `rrn` | `^(\d{6})-?([1-8])(\d{6})$` + 생년월일 실재성 | 주민등록번호를 다시 확인해 주세요 |
| `bookingNo` | 선택 · 40자 이내 · 빈 값은 `null`로 저장 | (없음) |

**미래 이용일에 24시간 여유를 두는 이유**: 서버 시각(UTC)과 신청자가 보는 KST가 어긋나
오늘 이용한 사람이 거절당하는 일을 막는다.

**금액 상한 1,000만원의 근거**: 이 공간의 하루 최대 이용료를 크게 웃도는 값이라, 넘으면
오타이거나 장난이다. 길이 초과와 마찬가지로 **자르지 않고 거절**한다 — 조용히 자르면
신청자가 낸 값과 우리가 저장한 값이 달라진다.

**주민번호 검증에서 일부러 하지 않는 것 — 체크섬**

흔히 쓰는 주민번호 체크섬(가중치 합 검증)을 넣지 않는다. **2020-10-06 이후 발급분은 뒷자리
6개가 임의 부여로 바뀌어 검증식이 성립하지 않는다.** 체크섬을 넣으면 정상적으로 발급된 최근
번호를 우리가 거절하게 되고, 신청자는 자기 번호가 왜 안 되는지 알 길이 없다. 대신 자릿수·
성별코드(1~8)·생년월일 실재성까지만 본다.

생년월일 실재성은 성별코드로 세기를 가른 뒤 `Date`로 되돌아오는지 확인한다 —
1·2·5·6 = 1900년대, 3·4·7·8 = 2000년대. `2월 30일` 같은 값은 `Date`가 다음 달로 넘겨버리므로,
연·월·일이 모두 그대로 돌아올 때만 통과시킨다.

### 4-2. 3.3% 원천징수 미리보기

**기능**: 금액을 입력하면 청구 금액·원천징수액·예상 지급액을 보여준다.

- 계산식은 **`Math.floor(amount * 0.033)`** 하나뿐이고, **세 곳이 같은 식을 쓴다** —
  신청 페이지(`updateCalc`) · 알림(`notify.ts`의 `netAmount`) · 어드민(`netOf`).
  화면과 알림이 다른 숫자를 말하면 신청자가 둘 중 무엇이 맞는지 묻게 된다.
- **참고값이다.** 실제 지급액은 사람이 확정한다 — 원 단위 절사 규칙이 상황에 따라 다르고,
  그걸 이 페이지가 단정하면 분쟁이 된다. 화면에도 "원 단위는 실제 지급 시 조정될 수 있어요"로
  적혀 있다.
- **공제액·지급 예정액을 DB에 저장하지 않는다.** 세율이 바뀌면 과거 행의 뜻이 달라지기 때문이다.
  저장하는 것은 신청자가 청구한 `amount` 하나이고, 3.3%는 볼 때마다 다시 계산한다.

### 4-3. 리뷰 확인

**기능**: "이용 후 리뷰를 남겼습니다" 체크박스 하나. 서버가 `=== true`인지 자르고,
접수되면 `review_confirmed_at`에 **서버가 아는 접수 시각**을 찍는다.

- boolean이 아니라 **시각**으로 남긴다(`consented_at`과 같은 이유). 확인은 "했다"가 아니라
  "언제 했다"가 기록이어야 대조가 된다. boolean이면 값이 바뀌었을 때 언제 바뀌었는지 알 수 없고,
  null 하나로 '안 함'과 '아직 안 물어봄'이 뭉개진다.
- 클라이언트가 보낸 시각을 믿지 않는다.
- 화면·알림·어드민 모두 **'확인됨'이 아니라 '남겼다고 함'**으로 적는다. 실제 리뷰는 사람이
  판매 채널에서 대조해야 하는데, 둘을 같은 말로 쓰면 대조를 건너뛰게 된다.

### 4-4. 암호화 저장

**기능**: 검증을 통과한 주민번호·계좌번호를 AES-GCM으로 암호화한 뒤에만 저장한다.

| 원칙 | 구현 | 이유 |
| --- | --- | --- |
| 암호화 위치는 **Edge Function** | `crypto.ts` | pgcrypto를 쓰면 키가 SQL 문에 실려 쿼리 로그·에러 메시지에 남는다 |
| 키는 **Edge Function 시크릿에만** | `RRN_ENCRYPTION_KEY` | DB에는 복호화 수단이 없다. DB가 통째로 새도 주민번호는 안 샌다 |
| 알고리즘 | AES-GCM 256bit, IV 12바이트 | 인증 태그가 붙어 **조작된 암호문은 복호화가 실패**한다. CBC였다면 조용히 쓰레기를 돌려줬을 것 |
| IV는 **값마다 새로** | `crypto.getRandomValues(12)` | 재사용하면 같은 평문이 같은 암호문이 되어, 키가 없어도 '두 사람의 주민번호가 같다'가 드러난다 |
| 키 형식 검증 | base64 디코드 + **32바이트** 확인 | 짧은 키가 조용히 들어와 약한 암호가 되는 것을 막는다 |
| **평문 폴백 없음** | 키 미설정·형식 오류·길이 불일치 → `503` | 시크릿을 빠뜨린 배포 한 번이 평문 저장으로 조용히 이어지면 안 된다 |
| **암호화가 저장보다 먼저** | `store.insert()`가 `encrypt()` 두 개를 `await` 한 뒤에 `insert` | 키가 없으면 **행 자체가 안 생긴다**. 평문이 잠깐이라도 컬럼에 앉았다 나중에 암호화되는 경로를 만들지 않는다 |
| 평문 컬럼이 **존재하지 않음** | `payback_claims`에 `rrn` 컬럼 없음 | 만들면 언젠가 채워진다 |

저장 형태는 **`base64(iv ‖ ciphertext)`** 한 덩어리다. IV를 따로 컬럼에 두지 않는다 —
두 값이 갈라지면 한쪽만 마이그레이션되는 사고가 가능해진다.

키 미설정 503은 `index.ts`가 **400으로 뭉개지 않고 그대로 올려보낸다.** 400으로 바꾸면
신청자가 자기 입력을 고치려 들지만, 고칠 것은 서버 설정이다.

### 4-5. 마스킹 병행 저장

**기능**: 암호문과 함께 마스킹 값을 별도 컬럼에 저장한다.

| 값 | 형태 | 예 |
| --- | --- | --- |
| `rrn_masked` | 생년월일 6자리 + `-` + 별표 7개 | `990101-*******` |
| `account_masked` | 앞자리 전부 별표 + **뒤 4자리** | `******7890` |

- 어드민 목록은 **마스킹만 읽어 그린다.** 화면을 한 번 그릴 때마다 복호화하면, 볼 필요가 없는
  순간에도 평문이 만들어지고 그게 로그·메모리·화면 캡처에 남는다.
- 계좌 뒤 4자리를 남기는 이유는 사람이 계좌를 대조할 때 그것만 보기 때문이다.
- 주민번호 형식이 어긋나 마스킹을 못 만들면 `******-*******`로 떨어진다(값이 새는 대신
  아무것도 안 알려주는 쪽).

### 4-6. 접수 알림 (항목 최소화)

**기능**: 접수 사실을 Mattermost 채널로 알린다. 성공하면 `notified_at`을 찍는다.

**알림에 싣는 것**

| 항목 | 값 |
| --- | --- |
| 신청자 | 이름 |
| 이용일 | `used_on` |
| 예약번호 | 있으면, 없으면 `—` |
| 청구 금액 / 원천징수 3.3% / 예상 지급액 | 금액 3종 |
| 리뷰 | "신청자가 남겼다고 확인" |

**싣지 않는 것: 주민번호 · 계좌번호 · 연락처 · 이메일.**

`apply/`의 알림은 신청 내용을 통째로 채널에 실어 보내지만 여기서 그걸 따라 하면 안 된다.
Mattermost 메시지는 **검색되고, 전달되고, 잠금화면에 알림으로 뜨고, 우리가 정한 파기 시점과
무관하게 채널에 영원히 남는다.** 암호화해서 DB에 넣어 놓고 같은 값을 평문으로 채널에 뿌리면
§24-2③을 지킨 의미가 없다. 연락처까지 뺀 것은 같은 판단의 연장이다 — 채널이 받는 것은
"누가 얼마를 청구했다"까지이고, 나머지는 어드민에서 본다.

메시지 본문 마지막 줄("계좌·주민번호는 알림에 담지 않습니다 — 어드민 지원금 신청 탭에서
확인하세요")은 **왜 여기 계좌가 없는가에 대한 답**이다. 지우면 다음 사람이 친절하게 추가한다.

**순서가 계약이다 — 저장 먼저, 알림 나중.** 뒤집으면 웹훅이 죽어 있던 동안의 신청이 사라지고
신청자는 보냈다고 믿는다. 알림 함수는 어떤 예외도 밖으로 던지지 않으며, 못 간 알림은
`notified_at`이 null인 것으로 드러난다(어드민에 **알림 못 감** 배지).

표 칸 값은 `|`를 이스케이프하고 줄바꿈을 공백으로 접는다 — 신청자가 친 글자가 알림의 구조를
바꾸면 안 된다.

### 4-7. 어드민 목록

**기능**: `admin_list_paybacks` RPC로 전체 신청을 접수 역순으로 그린다.

- **RPC가 암호문을 내리지 않는다.** 브라우저는 그걸 쓸 일이 없고, 안 내리면 안 새는 값이다.
  대신 `has_secret`(= `rrn_enc is not null`)만 내려 보기 버튼을 그릴지 판단한다.
- 목록 조회가 실패하면 목록을 비우고 오류 문구를 띄운다 — '신청 없음'으로 오해하면 신청이
  조용히 사라진 것처럼 보인다.
- 배지: `지급완료`/`반려` · `알림 못 감`(`notified_at` null) · `파기됨`(`has_secret` false).
  파기된 건은 보기 버튼 자체를 그리지 않는다 — '보기'가 안 되는 이유를 화면이 먼저 말해야 한다.
- 버튼은 상태에 따라 다르다: `received`일 때만 **지급 완료**·**반려**가 보이고,
  `has_secret`일 때만 **주민번호·계좌 보기**가 보인다.

### 4-8. 한 건 열람 (`reveal`)

**기능**: 어드민이 **주민번호·계좌 보기**를 누른 그 한 건만 서버에서 복호화해 돌려준다.

```
[보기] 클릭
  → claim 함수 reveal (id + 비밀번호)
      → payback_claims에서 rrn_enc·account_enc·purged_at 조회
         · 행 없음        → 404
         · 암호문이 null  → 410 "이미 파기된 신청이에요"
      → 두 값 복호화 (실패 시 500 — 조용히 빈 값을 주지 않는다)
      → payback_reveal_log 에 (claim_id, at, ip) 기록
         · 기록 실패해도 응답은 준다 (부가 장치이지 열람의 조건이 아니다)
  → DOM의 마스킹 셀 두 개를 평문으로 교체, 버튼은 [숨기기]로
[숨기기] 클릭
  → 캐시에 있던 마스킹 값으로 되돌린다 (DOM에서 평문 제거)
```

- **복호화 결과를 자바스크립트 변수에 캐시하지 않는다.** 캐시하면 탭을 한 번 열었다는 사실만으로
  평문 주민번호가 페이지 메모리에 계속 살아 있게 된다.
- 숨기기는 **DOM에서 지운다.** `display:none`으로 두면 개발자 도구·페이지 저장에 그대로 남는다.
- **복호화한 값을 로그에 찍지 않는다.** 디버깅이 편해지는 대신 주민번호가 로그로 샌다.
- 목록 전체 복호화 경로는 만들지 않는다.

### 4-9. 열람 로그 (`payback_reveal_log`)

**기능**: 언제·어디서(IP)·어느 건을 열었는지 남긴다. **복호화된 값 자체는 남기지 않는다** —
남기면 이 표가 곧 두 번째 주민번호 저장소가 된다.

**왜 별도 테이블인가**: 기록을 `payback_claims` 행에 얹으면 그 행의 파기 주기(지급 1년 뒤,
반려 즉시)를 같이 따라가 사라진다. 접속기록은 그보다 오래 살아야 한다 — 「개인정보의 안전성
확보조치 기준」이 고유식별정보 취급 기록을 **2년** 보관하도록 요구하고, 무엇보다 '언제 누가
열었나'는 사고가 난 **뒤에** 필요한 정보라서 원본이 지워진 뒤에도 남아야 한다.

RLS on + 정책 없음 = service_role만. 접속기록을 열람 대상이 스스로 지울 수 있으면 의미가 없다.

### 4-10. 지급 완료 (`mark_paid`)

**기능**: `status = 'paid'`, `paid_at = now`, `admin_memo` 저장. 메모는 500자로 자른다.

⚠️ **파기 크론이 매달 곳이 `paid_at`이다.** 지급하고도 이 버튼을 누르지 않으면 보유기간이
지나도 주민번호가 안 지워진다. 어드민 화면에 그 경고가 적혀 있다 —
"지급을 마치면 반드시 '지급 완료'를 눌러 주세요."

### 4-11. 반려 (`reject`) — 즉시 파기

**기능**: `status = 'rejected'`, `rrn_enc = null`, `account_enc = null`, `purged_at = now`,
`admin_memo` 저장.

- **크론을 기다리지 않는다.** 지급하지 않으면 지급명세서도 없고, 그러면 주민번호를 들고 있을
  근거가 사라진다. 근거가 사라진 개인정보는 지체 없이 파기해야 한다.
- **행은 남긴다.** 누가 신청했고 왜 반려됐는지는 기록이어야 한다.
- 되돌릴 수 없는 일이라 어드민이 `confirm`으로 한 번 더 묻는다.
- 파기 후 그 건을 열람하면 410이고, 목록에서 보기 버튼 자체가 사라진다.

## 5. 데이터 모델

```typescript
/** 브라우저가 보내는 접수 요청 (payback.html). */
interface ClaimSubmitRequest {
  action: 'submit';
  name: string;
  phone: string;
  email: string;
  usedOn: string;         // 'YYYY-MM-DD'
  bookingNo: string;      // 빈 문자열 허용 → 서버가 null로
  amount: number;         // 정수(원)
  bank: string;
  accountHolder: string;
  account: string;        // 하이픈 있어도 됨 — 서버가 숫자만 남긴다
  rrn: string;            // '000000-0000000'
  website: string;        // 허니팟. 비어 있어야 정상
  reviewDone: boolean;    // true 만 인정
  consent: boolean;       // true 만 인정
}

/** 어드민 요청 (admin.html). */
interface ClaimAdminRequest {
  action: 'reveal' | 'mark_paid' | 'reject';
  password: string;       // ADMIN_PASSWORD
  id: number;             // 양의 정수
  memo?: string;          // 500자 초과분은 서버가 자른다
}

/** 검증을 통과한 저장 직전 형태. 주민번호·계좌는 아직 평문 — 암호화는 store 직전에 한 번만. */
interface Claim {
  name: string;
  phone: string;
  email: string;
  bookingNo: string | null;
  usedOn: string;
  amount: number;
  bank: string;
  accountHolder: string;
  account: string;        // 숫자만
  rrn: string;            // '990101-1234567' (하이픈 있는 한 형태로 통일)
  reviewDone: true;
}

type Validated =
  | { ok: true; value: Claim }
  | { ok: true; spam: true }        // 허니팟 — 저장·알림 없이 200
  | { ok: false; error: string };   // error 는 신청자에게 그대로 보이는 한국어 문구

type ClaimStatus = 'received' | 'paid' | 'rejected';

/** public.payback_claims 한 행. */
interface PaybackClaimRow {
  id: number;                      // bigint identity
  name: string;
  phone: string;
  email: string;
  booking_no: string | null;       // 전화 예약은 예약번호가 없다
  used_on: string;                 // date
  amount: number;                  // integer, check (amount > 0)
  bank: string;
  account_holder: string;
  account_enc: string | null;      // 🔒 AES-GCM base64(iv 12B ‖ cipher). null = 파기됨
  account_masked: string;          // '******7890'
  rrn_enc: string | null;          // 🔒 같은 형식. null = 파기됨. 평문 컬럼은 존재하지 않는다
  rrn_masked: string;              // '990101-*******'
  status: ClaimStatus;             // default 'received'
  paid_at: string | null;          // 파기 크론이 매달리는 값
  purged_at: string | null;        // 암호문을 지운 시각. 행 자체는 회계 기록이라 남는다
  admin_memo: string | null;
  consented_at: string;            // 서버가 찍는 접수 시각
  created_at: string;              // default now()
  notified_at: string | null;      // null = 알림이 못 감
  review_confirmed_at: string | null;  // 리뷰 확인 시각. null = 확인하지 않음
}

/** admin_list_paybacks(p_password) 가 내려주는 행 — 암호문 두 컬럼이 빠져 있다. */
interface AdminPaybackListRow {
  id: number;
  name: string;
  phone: string;
  email: string;
  booking_no: string | null;
  used_on: string;
  amount: number;
  bank: string;
  account_holder: string;
  account_masked: string;
  rrn_masked: string;
  status: ClaimStatus;
  paid_at: string | null;
  purged_at: string | null;
  admin_memo: string | null;
  created_at: string;
  notified_at: string | null;
  review_confirmed_at: string | null;
  /** 컬럼이 아니라 RPC가 만든 값 — `rrn_enc is not null`. 보기 버튼을 그릴지만 판단한다. */
  has_secret: boolean;
}

/** public.payback_reveal_log 한 행. 복호화된 값은 절대 담지 않는다. */
interface PaybackRevealLogRow {
  id: number;
  claim_id: number;   // → payback_claims(id) on delete cascade
  at: string;         // default now()
  ip: string | null;  // cf-connecting-ip (spec_admin_auth 참조)
}

/** reveal 응답 — 이 값은 응답 본문에만 존재한다. 로그에 찍지 않는다. */
interface RevealResponse {
  rrn: string;
  account: string;
}
```

### 입력 길이 상한

| 필드 | 상한 | 초과 시 |
| --- | --- | --- |
| `name` | 40 | 자르지 않고 거절 |
| `phone` | 30 | 자르지 않고 거절 |
| `email` | 120 | 자르지 않고 거절 |
| `bookingNo` | 40 | 자르지 않고 거절 |
| `bank` | 30 | 자르지 않고 거절 |
| `accountHolder` | 40 | 자르지 않고 거절 |
| `account` | 30(원문) / 8~20(숫자만) | 자르지 않고 거절 |
| `memo` (어드민) | 500 | **자른다** — 운영자가 쓰는 값이라 거절보다 절삭이 낫다 |

## 6. 데이터 저장 구조

```
public.payback_claims          RLS on · 정책 0개 (Edge Function·RPC 전용)
  ├─ 신청자      name · phone · email
  ├─ 청구 내용   booking_no · used_on · amount
  ├─ 계좌        bank · account_holder · account_enc🔒 · account_masked
  ├─ 주민번호    rrn_enc🔒 · rrn_masked          ← 평문 컬럼 없음
  ├─ 처리        status · paid_at · purged_at · admin_memo
  └─ 시각        consented_at · created_at · notified_at · review_confirmed_at
  index: payback_claims_by_created (created_at desc) · payback_claims_by_status (status)

public.payback_reveal_log      RLS on · 정책 0개
  └─ claim_id → payback_claims(id) on delete cascade · at · ip
  index: payback_reveal_log_at (at desc)

function public.admin_list_paybacks(p_password text)   security definer
  → 비밀번호 검증은 admin_list_reservations 에 위임
  → 암호문 두 컬럼을 빼고, has_secret 을 만들어 created_at desc 로 반환
```

### 보유·파기

| 상태 | 언제 | 무엇을 | 누가 |
| --- | --- | --- | --- |
| 지급완료 | 지급(`paid_at`) **1년 후** | `rrn_enc`·`account_enc` → null, `purged_at` 기록 | pg_cron `payback-claims-purge` (`41 4 * * *`) |
| 접수된 채 방치 | 접수(`created_at`) **1년 후** | 같음 | 같은 크론 |
| 반려 | **즉시** | 같음 | 반려를 누른 그 순간 Edge Function |
| 열람 로그 | 기록 **2년 후** | 행 삭제 | pg_cron `payback-reveal-log-purge` (`47 4 * * *`) |

크론은 **'사람이 잊은 것'만 줍는다** — 반려 즉시 파기는 크론이 아니라 함수가 한다.

**행은 지우지 않고 암호문만 지운다.** 누구에게 얼마를 언제 지급했는가는 회계 기록이라 남아야
하고, 주민번호·계좌는 남으면 안 된다. 둘을 한 행에 두되 파기 대상을 컬럼으로 가른 이유가 이것이다.

## 7. 기술 구현

### 함수 구조 — 단일 책임으로 쪼갠 이유

```
supabase/functions/claim/
  index.ts       ← HTTP 표면만: CORS · 역할 판정 · 라우팅 · 직렬화
  validate.ts    ← 순수 검증 + 마스킹. 암호화도 DB도 없다 → 키 없이 규칙 전체를 테스트
  crypto.ts      ← 평문 ↔ 암호문. 여기 말고는 아무도 키를 만지지 않는다
  store.ts       ← payback_claims 접근. 평문 주민번호가 이 파일 밖으로 나가지 않는다
  notify.ts      ← Mattermost. 민감값을 아예 받지 않는 자리에 둔다
  errors.ts      ← HandlerError(status, message)
  crypto.test.ts · validate.test.ts
```

`errors.ts`를 `control/handlers/shared.ts`에서 가져다 쓰지 않은 이유: 그 파일이 ThinQ 클라이언트
팩토리를 함께 들고 있어, import 하는 순간 이 함수와 무관한 냉난방 설정까지 딸려온다.

### 주요 함수

```
validate.ts
  ├── validate(body) → Validated       검증 + 정규화(숫자만 남기기, 하이픈 형태 통일)
  ├── maskRrn(rrn)                     '990101-*******'
  └── maskAccount(account)             '******7890'

crypto.ts
  ├── loadKey()                        base64 → 32바이트 확인 → importKey (extractable=false)
  ├── encrypt(plain) → base64(iv‖c)    IV 매번 새로
  └── decrypt(packed) → plain          길이·인증 태그 실패 시 예외

store.ts
  ├── dbClient()                       service_role, persistSession=false
  ├── insert(sb, claim, at) → id       암호화 두 개를 먼저, 그 다음 insert
  ├── markNotified(sb, id, at)         실패해도 접수는 성공 — console.error 만
  ├── reveal(sb, id)                   404 / 410 / 복호화
  ├── markPaid(sb, id, at, memo)
  └── reject(sb, id, at, memo)         암호문 null + purged_at

notify.ts
  ├── netAmount(amount) → {tax, net}   Math.floor(amount * 0.033)
  ├── buildMessage(claim, at)          민감값을 넣지 않는 표
  └── notify(claim, at) → boolean      예외를 밖으로 던지지 않는다
```

### 오류 응답

| 상태 | 언제 | 본문 |
| --- | --- | --- |
| 400 | 검증 실패 · JSON 아님 · 알 수 없는 action · id 형식 오류 | 한국어 안내 문구 |
| 401 | 어드민 비밀번호 불일치 (실패를 시도 제한 장부에 기록) | `invalid password` |
| 404 | 해당 신청 없음 (`reveal`) | 해당 신청을 찾을 수 없습니다 |
| 405 | POST가 아님 | POST만 허용합니다 |
| 410 | 이미 파기된 건을 열람 | 이미 파기된 신청이에요 (보유기간 경과 또는 반려) |
| 429 | 시도 제한 (`spec_admin_auth`) | 제한 안내 문구 |
| 500 | 저장 실패 · 복호화 실패 | 처리 중 오류가 발생했습니다 |
| 503 | `RRN_ENCRYPTION_KEY` 또는 `ADMIN_PASSWORD` 미설정 | 서버 설정이 완료되지 않았습니다 |

CORS 헤더는 요청의 오리진을 보고 매번 만든다 — 모듈 상수로 두면 동시 요청이 서로의 것을 물려받는다.

### 시크릿

| 이름 | 없으면 |
| --- | --- |
| `RRN_ENCRYPTION_KEY` | **접수 자체가 503으로 거부된다** (평문 폴백 없음). base64 32바이트여야 한다 |
| `ADMIN_PASSWORD` | 어드민 action 전부 503 |
| `MATTERMOST_APPLY_WEBHOOK_URL` 또는 `MATTERMOST_WEBHOOK_URL` | 접수는 되고 알림만 안 간다 |
| `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` | DB 접근 불가 |

⚠️ **키를 잃으면 기존 암호문은 영원히 못 연다.** 회전하려면 옛 키로 전부 복호화해 새 키로 다시
넣는 마이그레이션이 필요한데, **지금 그런 경로가 없다.**

### 배포 순서 (순서가 중요하다)

```
supabase secrets set RRN_ENCRYPTION_KEY='...'   # 이게 먼저다
supabase db push                                 # 테이블 + 파기 크론 + admin_list_paybacks
supabase functions deploy claim
deno test --allow-env supabase/functions/claim/  # 암복호화·검증 (키·DB 불필요)
```

키 없이 함수만 올리면 모든 접수가 503으로 튕긴다.

### 테스트가 지키는 것

- `crypto.test.ts` — 왕복 복원 · **암호문에 평문이 남지 않음** · **같은 값도 매번 다른 암호문**
  (IV 재사용 금지) · 조작된 암호문 거부 · 키 미설정 시 예외. 고정 테스트 키를 환경변수에 넣고 돈다.
- `validate.test.ts` — 검증 규칙과 마스킹.

## 8. API 엔드포인트

| 메서드 | 경로 | action | 인증 | 설명 |
| --- | --- | --- | --- | --- |
| POST | `/functions/v1/claim` | `submit` | 없음(공개) | 검증 → 암호화 → 저장 → 알림 |
| POST | `/functions/v1/claim` | `reveal` | `ADMIN_PASSWORD` | 한 건 복호화 + 열람 로그 |
| POST | `/functions/v1/claim` | `mark_paid` | `ADMIN_PASSWORD` | 지급 완료 표시 |
| POST | `/functions/v1/claim` | `reject` | `ADMIN_PASSWORD` | 반려 + 암호문 즉시 파기 |
| RPC | `admin_list_paybacks(p_password)` | — | 비밀번호(위임 검증) | 마스킹 목록 + `has_secret` |
| OPTIONS | `/functions/v1/claim` | — | — | CORS preflight |

## 9. 법적 근거

| 무엇 | 근거 | 이 스펙에 미치는 영향 |
| --- | --- | --- |
| 주민번호 **수집** | 소득세법 — 3.3% 원천징수와 지급명세서 제출 | 수집 근거가 동의가 아니므로, 신청 페이지 고지가 "법령에 따라 받습니다"다. 동의형으로 고치면 근거가 어긋난다 |
| 주민번호 **동의 수집 금지** | 「개인정보 보호법」 §24-2 | 주민번호는 개인정보 수집·이용 동의 항목에 **포함되지 않는다** (별도 고지) |
| 주민번호 **암호화 저장** | 「개인정보 보호법」 §24-2③ (강행 규정) | AES-GCM 암호화가 선택이 아니라 의무. 평문 폴백·평문 컬럼이 없는 이유 |
| 고유식별정보 **취급 기록 보관** | 「개인정보의 안전성 확보조치 기준」 | 열람 로그를 **2년** 보관 — 원본(1년)보다 오래. 그래서 별도 테이블 |
| 목적 달성 후 **지체 없는 파기** | 「개인정보 보호법」 파기 원칙 | 반려는 크론을 기다리지 않고 그 자리에서 암호문을 지운다 |

**보유 1년은 형운 결정(2026-08-10)이지 세법이 정한 값이 아니다.**
[확인 필요: 지급명세서 제출 주기와 실제 보관 의무 기간 — 세무사 확인 필요]

## 10. 의존성 / 관련 스펙

| 스펙 | 관계 |
| --- | --- |
| `spec_admin_auth` | `ADMIN_PASSWORD` 비교(`constantTimeEqual`) · 시도 제한 키(`cf-connecting-ip`)·저장소·해제 규칙 · `admin_list_reservations` 위임 검증이 그쪽 정본이다. 이 스펙은 그 위에 얹혀 있다 |
| `spec_support_apply` | 같은 프로그램의 앞 단계(신청·선정). `apply` 함수와 **일부러 분리**돼 있다 — 사유는 §1 |

## 파일(페이지) 구성

| 파일 | 경로 | 설명 |
| --- | --- | --- |
| `payback.html` | `06-applications/payback.html` | 공개 청구 폼. 3.3% 미리보기 · 법령 고지 · 허니팟 · 제출 후 폼 제거 |
| `admin.html` (지원금 신청 탭) | `06-applications/admin.html` (`view-paybacks` 마크업, 목록·열람·지급·반려 로직) | 마스킹 목록 · 한 건 열람 · 지급 완료 · 반려 |
| `index.ts` | `supabase/functions/claim/index.ts` | HTTP 표면 — CORS · 시도 제한 · 비밀번호 · action 라우팅 |
| `validate.ts` | `supabase/functions/claim/validate.ts` | 순수 검증 + 마스킹(`maskRrn`·`maskAccount`) |
| `crypto.ts` | `supabase/functions/claim/crypto.ts` | AES-GCM 암복호화. 키를 만지는 유일한 파일 |
| `store.ts` | `supabase/functions/claim/store.ts` | `payback_claims` 접근(`insert`·`reveal`·`markPaid`·`reject`) |
| `notify.ts` | `supabase/functions/claim/notify.ts` | Mattermost 알림 + `netAmount` |
| `errors.ts` | `supabase/functions/claim/errors.ts` | `HandlerError(status, message)` |
| `crypto.test.ts` | `supabase/functions/claim/crypto.test.ts` | 왕복 · IV 무작위 · 조작 거부 · 키 미설정 |
| `validate.test.ts` | `supabase/functions/claim/validate.test.ts` | 검증 규칙 · 마스킹 |
| `README.md` | `supabase/functions/claim/README.md` | 왜 이렇게 동작하는지(근거·시크릿·배포·미검증 항목) |
| `20260810200000_payback_claims.sql` | `supabase/migrations/` | 테이블 · RLS · 파기 크론 · `admin_list_paybacks` |
| `20260810210000_payback_review_check.sql` | `supabase/migrations/` | `review_confirmed_at` 추가 + RPC 재생성 |
| `20260813112000_payback_reveal_log.sql` | `supabase/migrations/` | 열람 로그 테이블 + 2년 파기 크론 |
| `vercel.json` | 레포 루트 | CSP · HSTS · `Referrer-Policy: no-referrer` |

## 변경 이력

| 날짜 | 변경 내용 |
| --- | --- |
| 2026-08-10 | 신청 페이지 + 암호화 보관 + 어드민 처리 (PR #67) |
| 2026-08-10 | 리뷰 작성 확인 체크(`review_confirmed_at`) 추가 (PR #68) |
| 2026-08-13 | 열람 로그(`payback_reveal_log`) + 어드민 경로 시도 제한 (PR #73) |
| 2026-08-14 | 역기획 스펙 최초 작성 |
