# spec_support_apply

> 타입라운지 공간 지원 프로그램의 **접수와 심사** 스펙. 누구나 공개 신청서(`/apply`)로 신청하고,
> 운영자는 어드민 "공간 지원 신청" 탭에서 선정·보류를 정한 뒤 결과 안내 문자를 내보낸다.
> 선정자가 이용 후 돈을 돌려받는 뒷단(페이백)은 `spec_payback_claim`이 담당한다.

## 1. 개요

**무엇을**: 이름·연락처·이메일·인스타그램·활용 목적을 받아 `support_applications` 장부에 넣고,
Mattermost로 운영진에게 알린다. 운영자는 그 목록을 보고 `selected`(선정) 또는 `held`(보류)를
정하며, 그 결정마다 결과 안내 문자가 한 번씩 나간다.

**왜 서버가 필요한가** — 편의가 아니라 필수다. `apply.html`은 소스가 그대로 공개되므로
브라우저가 DB에 직접 쓰게 하려면 `support_applications`에 anon insert 정책을 열어야 하고,
그 순간 검증도 스팸 덫도 우회된다. 읽기 정책은 더 나쁘다 — 누구나 신청자 전원의 이름·연락처·
이메일을 긁어간다. 그래서 테이블은 **RLS를 켜되 정책을 하나도 만들지 않았고**, service_role로
붙는 Edge Function과 SECURITY DEFINER RPC만이 경로다.

이 스펙을 관통하는 계약 세 가지:

| 계약 | 내용 | 뒤집으면 |
|---|---|---|
| 접수 순서 | 검증 → **저장** → 알림 → `notified_at` 표시 | 웹훅이 죽어 있던 동안의 신청이 통째로 사라진다. 신청자는 보냈다고 믿는다 |
| 실패 등급 | 저장 실패 = 500, 알림 실패 = 200(성공) | 신청자는 이미 다 적어 보냈다. 우리 채널 사정은 그 사람 책임이 아니다 |
| 결정 순서 | **상태 저장** → 문자 발송 | 문자는 갔는데 상태가 안 바뀐 건이 남아 다음에 또 나간다(받는 사람은 두 번 선정된 줄 안다) |

관련 PRD: `docs/prd/typelounge-ops/typelounge-ops-PRD.md` EPIC 7 — US-7.1(제출)·US-7.2(심사·결과 문자).

## 2. 기술 스택

프로젝트 공통(빌드 없는 단일 HTML + Supabase Edge Functions + Postgres) + 이 스펙 고유:

- **Deno / Supabase Edge Functions** — `supabase/functions/apply` 하나가 공개 접수와 어드민 결정을 함께 받는다
- **`jsr:@supabase/supabase-js@2`** — service_role 클라이언트(`store.ts`)
- **Mattermost Incoming Webhook** — 접수 알림 1통(마크다운 표 + 인용 블록)
- **SOLAPI** — 결과 안내 문자. 클라이언트는 `control/sms/solapi.ts`를 **그대로 재사용**한다(서명·타임아웃·실패 매핑이 실전 검증됨). 복사하면 두 벌이 갈라져 한쪽만 고쳐진다
- **pg_cron** — 보유기간 1년 집행(`support-applications-purge`)
- **`_shared/cors.ts` · `_shared/secret.ts` · `_shared/throttle.ts`** — 오리진 화이트리스트, 상수 시간 비교, 어드민 시도 제한
- 프런트는 프레임워크 없음 — `apply.html`·`admin.html` 각각이 단독 배포물이며 번들러가 없다

## 3. 실행 환경

| 구성 요소 | 런타임 | 배포 |
|---|---|---|
| `apply.html` (`/apply`) · `admin.html` (`/admin`) | 브라우저(모바일 우선) | `main` 머지 시 GitHub Actions → Vercel(자동) |
| `functions/apply` | Deno(Supabase Edge) | `supabase functions deploy apply` — **사람이 돌린다** |
| 마이그레이션·크론 | Postgres(Supabase) | `supabase db push` — **사람이 돌린다** |
| 단위 테스트 | Deno | `deno test supabase/functions/apply/` (DB·웹훅 불필요) |

시각은 전부 **KST 고정**(`Asia/Seoul`)으로 표시한다. 저장은 `timestamptz`다.
크론 스케줄은 `31 4 * * *` — 다른 정리 잡(`device-events-cleanup` `17 4 * * *`)과 분을 겹치지 않게 뒀다. [확인 필요: pg_cron이 쓰는 시간대. 마이그레이션 어디에도 `cron.timezone`을 설정하지 않아 DB 기본값(Supabase는 UTC)을 따를 가능성이 크다 — 그러면 실제 실행은 13:31 KST다]

### 시크릿

| 이름 | 필요 | 없으면 |
|---|---|---|
| `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` | 필수 | Supabase가 자동 주입 |
| `ADMIN_PASSWORD` | 필수 | 어드민 action 전면 503(통과가 아니라 거부) |
| `MATTERMOST_WEBHOOK_URL` | 사실상 필수 | 접수는 되고 알림만 안 간다(`notified_at` null) |
| `MATTERMOST_APPLY_WEBHOOK_URL` | 선택 | 없으면 위 채널로 간다. 신청이 잦아져 다른 알림을 덮으면 **코드를 고치지 않고** 이 값만 넣어 분리 |
| `SOLAPI_API_KEY` · `SOLAPI_API_SECRET` · `SOLAPI_SENDER` | 결과 문자에 필요 | 상태는 바뀌고 발송만 건너뛴다(`not_configured`) — 장부에 적지 않는다. 시도조차 못 한 것은 '실패'와 다르다 |

## 4. 접근 제어

한 함수에 **등급이 다른 두 경로**가 있다. 접수는 공개고, 결정은 손님에게 문자를 보내는 일이라 어드민 전용이다.

```
POST /functions/v1/apply
  |
  +- action 없음 | "submit"  -- 공개. 비밀번호를 안 본다. 시도 제한도 안 센다
  |
  +- preview | decide | mark_manual  -- 어드민
        1) isThrottled(cf-connecting-ip)  -> 참이면 429
        2) ADMIN_PASSWORD 미설정          -> 503 (통과가 아니라 거부)
        3) constantTimeEqual 불일치       -> recordFailure(surface="apply") -> 401
        4) 통과 -> action 분기
```

- **`control`과 합치지 않았다.** 저기서 비밀번호를 안 보낸 요청은 `guest`고, guest의 모든 action은
  **예약 시간 안에서만** 열린다(`control/reservation-window.ts`). 신청은 아무 때나 들어와야 하므로
  예외를 뚫어야 하는데, 그 게이트는 지나가던 사람이 남의 이용 중에 기기를 못 건드리게 막는 장치다.
  예외가 하나 생기면 "손님 경로는 예약 시간에만 열린다"가 더 이상 참이 아니게 된다.
- **시도 제한 카운터는 셋이 공유한다**(`control`·`claim`·`apply`가 같은 `ADMIN_PASSWORD`를 검증하므로).
  키는 `cf-connecting-ip` — XFF는 클라이언트가 위조하면 통째로 뚫린 실측이 있다(2026-08-13). 상세는 `spec_admin_auth`.
- **공개 접수는 제한 밖이다.** `submit` 분기가 위에서 이미 끝나므로 신청자는 429를 볼 일이 없다.
  대신 공개 submit 자체에는 지금 아무 유량 제한이 없다(§10 참조).
- **CORS는 화이트리스트다**(`_shared/cors.ts`, `typelounge.vercel.app`만). 브라우저만 지키는 한 겹이고,
  실제 권한은 위 판정이 자른다.
- **어드민 목록 조회는 Edge Function이 아니라 PostgREST RPC**(`admin_list_applications`)를 통한다.
  비밀번호 검증은 `admin_list_reservations`에 위임한다 — 평문 비밀번호를 SQL에 또 박으면 같은
  비밀이 늘어나기만 하고 바꿀 때 한 군데를 빠뜨린다. 이 경로는 시도 제한 배선 밖이다(`spec_admin_auth`의 Future Work).

## 5. 페이지 구성

### 5-1. 공개 신청서 `/apply` (`06-applications/apply.html`)

```
+--------------------------------------+
|                             [야간/주간]|  테마 토글(고정, 우상단)
|            TYP[E] LOUNGE             |  워드마크(레이어드 E, 인라인 SVG)
|           공간 지원 프로그램            |
|                                      |
|  +--------------------------------+  |
|  | 안내 문구 (임시 - noindex 사유) |  |  .intro
|  +--------------------------------+  |
|  +--------------------------------+  |
|  |   [ANTIEGG]  |  [NMWC]         |  |  .sponsor - 공식 SVG 인라인
|  |  ANTIEGG와 NMWC의 후원으로...   |  |
|  +--------------------------------+  |
|                                      |
|  신청 정보                            |  h2 (오렌지, 자간 확대)
|  이름 *          [______________]    |
|  연락처 *        [010-0000-0000 ]    |
|  이메일 *        [______________]    |
|  인스타그램 선택 [@typelounge   ]    |
|    계정이 없으시면 비워 두셔도 돼요.    |
|  활용 목적 *     +--------------+    |
|                  | (여러 줄)     |    |
|                  +--------------+    |
|    1000자까지 쓰실 수 있어요.          |
|  ( 화면 밖: website - 스팸 덫 )       |
|                                      |
|  +--------------------------------+  |
|  | 개인정보 수집·이용 동의          |  |
|  |  수집 항목 / 이용 목적 /         |  |
|  |  보유 기간: 접수일로부터 1년      |  |
|  |  [ ] 위 내용에 동의합니다         |  |
|  +--------------------------------+  |
|  [        신청서 보내기        ]      |
|  (오류 문구 - 서버가 한 말 그대로)     |
|  ----------------------------------  |
|  문의는 hq@nmwc.ai.kr 로 주시면 돼요.  |
+--------------------------------------+
```

제출에 성공하면 폼이 통째로 숨고 같은 자리에 완료 화면이 들어온다.

```
+--------------------------------------+
|                  V                   |
|         신청이 접수됐어요               |
|  확인한 뒤 남겨 주신 연락처로           |
|  개별 연락드릴게요.                    |
+--------------------------------------+
```

### 5-2. 어드민 "공간 지원 신청" 탭 (`06-applications/admin.html` #view-applications)

```
+---------------+----------------------------------------------+
| 예약관리       |  신청 내역                                    |
| 공간 제어      |  +----------------------------------------+  |
| CCTV          |  | (조회 실패 시에만) 불러오지 못했어요...    |  |  #appNotice
| >공간 지원 신청 |  +----------------------------------------+  |
| 지원금 신청     |  +----------------------------------------+  |
|               |  | 홍길동 [선정] [알림 못 감]                |  |  이름 + 배지
|               |  | 2026. 08. 10. 14:32 접수 ·               |  |
|               |  | 2026. 08. 11. 09:05 결정                 |  |
|               |  | 연락처   010-0000-0000                   |  |
|               |  | 이메일   a@b.kr                          |  |
|               |  | 인스타   @handle (안전할 때만 링크)        |  |
|               |  | 활용 목적 여러 줄이 줄바꿈 그대로           |  |  dd.pre
|               |  | 메모     (admin_memo 있을 때만)           |  |
|               |  | 결과 문자 선정 발송됨                      |  |  superseded 제외
|               |  | ( 선정 ) ( 보류 ) ( 문구 복사·직접 발송 )   |  |
|               |  +----------------------------------------+  |
|               |  ... (created_at 최신순) ...                  |
|               |  [ 새로고침 ]                                 |
|               |  ! 접수일로부터 1년이 지나면 자동 파기됩니다     |
+---------------+----------------------------------------------+
```

### 5-3. 결정 확인 모달 (`#decideModal`)

**누르자마자 보내지 않는다.** 서버가 만든 실제 문구를 받아 보여주고, 거기서 한 번 더 눌러야 나간다.

```
+------------------------------------------+
| 선정 안내 문자                       [X] |  제목 = 종류 + 모드
| 홍길동 · 010-0000-0000                   |  #decideWho
| +--------------------------------------+ |
| | [타입라운지] 안녕하세요, ...           | |  readonly textarea
| | (서버 preview 응답 그대로 · 14행)      | |  #decideBody
| +--------------------------------------+ |
| 메모 (선택) - 선정·보류 사유              |
| [____________________________] 500자     |  #decideMemo
|              [ 취소 ] [ 이 문자로 보내기 ]|
+------------------------------------------+
```

모드가 `manual`이면 제목이 "선정 문구 복사", 안내가 "문자가 나가지 못했어요...", 버튼이 "직접 보냈어요"로 바뀐다.
문구를 불러오는 동안 확인 버튼은 비활성이고, 실패하면 본문 자리에 실패 사유가 들어간다.

## 6. 섹션별 상세

### 6-1. 신청 폼 — 필드와 검증 분담

| 칸 | 필수 | 클라이언트(`apply.html`) | 서버(`validate.ts`) |
|---|---|---|---|
| `name` | 필수 | 비었는지 · `maxlength=40` | 비었는지 · 40자 |
| `phone` | 필수 | 비었는지 · `maxlength=30` | 비었는지 · **숫자 9개 이상** · 30자 |
| `email` | 필수 | 비었는지 · `maxlength=120` | 비었는지 · `@` 앞뒤와 점 · 120자 |
| `instagram` | 선택 | `maxlength=60` | `@`·URL 벗겨 핸들만 · 60자 · 빈 값이면 `null` |
| `purpose` | 필수 | 비었는지 · `maxlength=1000` | 비었는지 · **1000자** |
| `consent` | 필수 | 체크 여부 | **`=== true`만 인정**(문자열 `"true"`도 거절) |
| `website` | 선택 | 화면 밖 칸(`.trap`) | 값이 있으면 스팸 판정 |

- **클라이언트 검증은 검증이 아니다.** 소스가 공개되므로 누구나 `fetch`로 함수를 직접 부를 수 있다.
  여기 검증은 왕복 한 번을 아끼는 것이 전부고, 문구는 서버가 돌려준 것을 그대로 띄운다 —
  양쪽에서 문구를 따로 관리하면 언젠가 서로 다른 말을 하게 된다.
- 입력 글꼴은 16px 미만으로 두지 않는다 — iOS Safari가 포커스할 때 화면을 확대해 손님이 폼에서 길을 잃는다.
- 제출 버튼은 전송 중 잠긴다(`sending` 플래그). 폼에 '취소'가 없어 반응이 늦다고 느끼면 실제로 다시 누르고,
  그러면 행도 알림도 두 개가 된다. **실패하면 버튼을 되돌린다** — 잠긴 채 두면 적어둔 내용을 가진 채 아무것도 못 한다.
- 오류 표시는 **서버가 한 말만** 옮긴다(`err.fromServer` 플래그). 연결 자체가 안 된 경우의 `err.message`는
  브라우저가 만든 영문(`Failed to fetch`)이라 신청자에게 아무것도 알려주지 못한다 —
  그때는 "연결에 실패했어요. 잠시 후 다시 시도해 주세요."로 바꿔 띄운다.

### 6-2. 서버 검증 순서 (`validate.ts`)

**순서 자체가 설계다.**

```
1) 덫(website)  -- 값이 있으면 즉시 spam. 다른 검증을 아예 안 본다
2) 값 정리      -- trim · 인스타 정규화
3) 동의(consent === true)
4) 필수: name -> phone -> phone 자릿수 -> email -> email 형식 -> purpose
5) 길이 상한: name40 · phone30 · email120 · instagram60 · purpose1000
```

- **덫이 맨 앞인 이유**: 봇이 다른 칸을 엉망으로 채웠어도 400을 돌려주면 "덫이 있다"는 사실만 알려주는 꼴이다.
- **스팸은 성공(200 `{ok:true}`)으로 답한다.** 저장도 알림도 하지 않지만 봇에게 실패를 알리지 않는다.
- **동의가 필수 칸보다 앞이다.** 동의 없이 들어온 개인정보는 애초에 저장하면 안 되는 값이라, 다른 문제를 지적하기 전에 자른다.
- **길이는 자르지 않고 거절한다.** 조용히 잘라 저장하면 신청자는 다 보냈다고 믿는데 우리는 잘린 것을 읽고,
  잘렸다는 사실이 아무 데도 안 남는다. `purpose` 1000자는 DB 위생이 아니라 **Mattermost 4000자 상한을 지키는
  실질적 장치**다 — 알림 한 통에 신청 하나가 통째로 들어간다.
- 이메일은 "`@` 앞뒤가 있고 점이 있다"까지만 본다. 그 이상은 오탈자를 못 잡으면서 정상 주소만 막는다.
- 전화번호는 숫자 개수만 센다(9개 이상). 국내외 표기가 제각각이라 형식을 강제하지 않는다 —
  **문자 발송 가능 여부는 다른 판정**이고(`normalizePhone`, 010은 11자리 고정), 거기서 걸리면 사람이 직접 보내는 경로로 간다.

### 6-3. 접수 알림 (Mattermost)

형식은 기존 알림(`control/automation/message.ts`·`spacecloud-gmail-sync.gs`)과 같은 `**제목** · 시각` + 마크다운 표다.

```
**공간 지원 프로그램 신청** · 2026. 08. 10. 14:32

| 항목 | 내용 |
|---|---|
| 이름 | 홍길동 |
| 연락처 | 010-0000-0000 |
| 이메일 | a@b.kr |
| 인스타그램 | [@handle](https://instagram.com/handle) |

**활용 목적**
> 첫 줄
> 둘째 줄
```

- **인젝션 방어**: 표 칸에 들어가는 값은 `|`를 이스케이프하고 줄바꿈을 공백으로 접는다.
  `|`는 칸을 쪼개고 줄바꿈은 표를 통째로 끝낸다 — 신청자가 친 글자가 알림의 **구조**를 바꾸면 안 된다.
  미용이 아니라 남이 쓴 문자열을 우리 형식에 넣을 때의 최소 방어다.
- **인스타그램은 `/^[A-Za-z0-9._]+$/`일 때만 링크**로 만든다. 아니면 글자로만 둔다 — 링크 문법이 깨지는 것보다 낫다.
  값이 없으면 `—`. 같은 판정을 어드민 렌더(`admin.html`의 `SAFE_HANDLE`)도 한다.
- **활용 목적만 표 밖**에 인용 블록으로 둔다. 자유 서술이라 여러 줄이 오는데 표 칸에 넣으면 줄바꿈이 사라져
  한 덩어리로 읽힌다. 인용 블록은 줄을 살리면서 신청자의 글과 우리 형식을 눈으로 구분해준다.
- **재시도 큐는 없다.** `control/automation/notify.ts`의 선점·되돌리기 장치는 기기 이벤트가 초당 여러 건 쌓이기
  때문에 있는 것이고, 신청은 하루 몇 건짜리 단발이다. 못 간 건은 `notified_at` null로 드러난다.

### 6-4. 어드민 심사 — 선정·보류

| 상태 | 뜻 | 결과 문자 |
|---|---|---|
| `received` | 접수(결과 미정). 기본값 | 없음 |
| `selected` | 선정 | 선정 안내(예약 링크·12시간 상한·페이백 절차·후원 크레딧·연락처) |
| `held` | 보류(대기) | 보류 안내(자리가 나면 연락 · **다시 신청하지 않아도 됨** · 후원 크레딧) |

- **탈락 상태는 일부러 없다**(형운 결정, 2026-08-10). 보류 문구가 "자리가 생기면 연락드린다"라 사실상 대기열이고,
  명시적 탈락을 만들면 그에 맞는 문구가 하나 더 필요해진다. 필요해지면 CHECK에 `rejected`를 더하고 문구를 추가한다.
- **버튼은 언제나 둘 다 보인다.** 보류였다가 선정되는 경로가 정상이고, 선정을 보류로 되돌릴 일도 생긴다.
  현재 상태와 같은 버튼은 `.done`으로 칠해져 구분된다.
- **선정 문구는 보류였던 사람에게도 그대로** 나간다 — 별도 문구를 두지 않는다(형운 결정).
- 메모(`admin_memo`)는 선택. 서버가 trim 후 500자로 자르고, 비면 `null`로 넣는다. 사람이 나중에
  "왜 이렇게 정했더라"를 되짚는 유일한 자리다.
- 결과 문자 줄은 **못 간 것을 숨기지 않는 것이 목적**이다. 상태는 '선정'인데 문자가 안 갔으면 당사자는 아무것도 모르고 있다.
  `sent`·`manual`은 평문, `sending`(멈춤)·`failed`·`no_phone`은 경고색으로 표시하고 `superseded`는 목록에서 뺀다.

### 6-5. 발송 결과 처리

`decide` 응답의 `status`를 사람 말로 옮긴다. 코드값을 그대로 띄우면 무슨 일이 일어났는지 알 수 없다.

| status | 어드민 문구 | 경고색 |
|---|---|---|
| `sent` | 문자를 보냈어요. | 아니오 |
| `already` | 이미 보낸 문자라 다시 보내지 않았어요. 상태는 바뀌었습니다. | 아니오 |
| `failed` | 상태는 바뀌었지만 문자가 나가지 못했어요. 문구를 복사해 직접 보내주세요. | 예 |
| `no_phone` | 상태는 바뀌었지만 문자를 받을 수 없는 번호예요. 문구를 복사해 직접 보내주세요. | 예 |
| `not_configured` | 상태는 바뀌었지만 문자 발송이 설정되지 않아 보내지 못했어요. | 예 |

`failed`·`no_phone` 건에는 카드에 [문구 복사 · 직접 발송] 버튼이 생기고, 여기서 `mark_manual`을 호출하면
`manual` 행이 새로 생긴다. 이때 `superseded`로 내려가는 것은 **`failed`·`superseded`가 아닌 행뿐이다**(`dispatch.ts`의 `.not()` 필터) —
`failed` 행은 그대로 남는다. 유니크 인덱스에서 이미 빠져 있어 자리를 막지 않고, 무엇이 실패했는지가 장부에 계속 보여야 하기 때문이다.
대가는 화면이다: `failed` 건은 직접 발송을 기록한 뒤에도 '발송 실패' 줄과 [문구 복사 · 직접 발송] 버튼이 함께 남는다.

### 6-6. 목록 조회 실패 처리

조회가 실패하면 **빈 목록으로 두지 않는다.** '아직 신청이 없어요'가 뜨면 읽는 사람은 신청이 안 들어온 줄 알고
그냥 닫는다 — 조용히 사라진 신청은 없는 기능보다 나쁘다. 목록을 비우고 경고 문구를 대신 띄운다.

문자 이력(`admin_list_application_sms`)은 **같이 받되 실패해도 목록은 그린다.** 이력을 못 받았다고
신청 목록까지 안 보이면 결과를 정하는 일 자체가 막힌다. 대신 이력 칸만 비어 보인다.

## 7. 데이터 구조(모델)

실제 SQL(`20260810000000_support_applications.sql` · `20260810220000_application_selection.sql`) 기준.

```typescript
/** 상태값 = 문자 종류. 둘이 어긋날 이유가 없어 같은 이름을 쓴다. */
type ApplicationSmsKind = 'selected' | 'held';
type ApplicationStatus = 'received' | ApplicationSmsKind;   // 탈락 상태는 일부러 없다

/** support_applications — 신청 내역이 남는 유일한 장부. */
interface SupportApplication {
  id: number;                  // bigint identity
  name: string;                // not null · 40자
  phone: string;               // not null · 30자 (문자 발송 가능 여부는 별도 판정)
  email: string;               // not null · 120자
  instagram: string | null;    // 핸들만. null = 계정이 없어도 신청 가능
  purpose: string;             // not null · 1000자. 원문 그대로(길이만 서버가 본다)
  consented_at: string;        // not null. 서버 시각 — 클라이언트가 보낸 시각을 믿지 않는다
  created_at: string;          // not null default now()
  notified_at: string | null;  // null = 접수는 됐는데 Mattermost 알림이 못 갔다
  status: ApplicationStatus;   // not null default 'received'
  decided_at: string | null;   // 선정·보류를 마지막으로 정한 시각
  admin_memo: string | null;   // 선정·보류 사유. 500자
}

/** application_sms — 결과 안내 문자 장부. 성공만이 아니라 실패·수동발송까지 남긴다. */
type ApplicationSmsStatus =
  | 'sending'      // 선점만 하고 발송 중
  | 'sent'         // 발송됨
  | 'failed'       // 벤더가 거절(유니크 인덱스가 자리를 비워 재시도 가능)
  | 'no_phone'     // 문자를 받을 수 없는 번호 — 사람이 직접 보내야 함
  | 'manual'       // 사람이 직접 보냄
  | 'superseded';  // 재발송으로 대체됨

interface ApplicationSms {
  id: number;
  application_id: number;      // FK -> support_applications(id) ON DELETE CASCADE
  kind: ApplicationSmsKind;
  status: ApplicationSmsStatus;
  to_phone: string | null;     // 정규화된 번호. no_phone이면 null
  body: string | null;         // 실제로 보낸 본문 — 템플릿은 바뀌므로 "그때 무엇을 보냈나"는 여기에만 남는다
  group_id: string | null;     // SOLAPI 그룹 ID
  error: string | null;        // 실패 사유
  created_at: string;
  sent_at: string | null;
}
```

Edge Function 내부 타입:

```typescript
/** 저장 가능한 형태로 정리된 신청(validate.ts). DB 컬럼의 부분집합이다. */
interface Application {
  name: string; phone: string; email: string;
  instagram: string | null; purpose: string;
}

type Validated =
  | { ok: true; value: Application }
  | { ok: true; spam: true }        // 저장·알림 없이 성공으로 응답
  | { ok: false; error: string };   // 신청자에게 그대로 보여줄 한국어 문구

/** 발송 한 번의 결과(dispatch.ts). */
type DispatchStatus = 'sent' | 'failed' | 'already' | 'no_phone' | 'not_configured';
interface DispatchResult {
  status: DispatchStatus;
  detail?: string;   // 실패 사유·안내 문구. 어드민이 그대로 보여준다
  body?: string;     // 사람이 직접 보낼 때 복사할 본문. no_phone·failed일 때 채운다
}
```

### 기본값·초기값 규칙

| 값 | 기본 | 이유 |
|---|---|---|
| `status` | `'received'` | 결과 미정이 기본이다. 신청은 들어온 순간 아무것도 정해지지 않았다 |
| `consented_at` | 서버 접수 시각 | 동의는 boolean이 아니라 **시각**으로 남긴다 — 동의 문구는 바뀌고, 어느 문구에 동의했는지는 시각으로만 되짚는다 |
| `notified_at` | `null` | 알림이 나가야만 채워진다. null이 곧 "못 간 알림"의 표지다 |
| `instagram` | `null` 허용 | 계정이 없는 사람을 접수 자체에서 막지 않기 위해서다. 나머지 넷은 없으면 연락도 검토도 못 하므로 필수 |
| `admin_memo` | `null` | 빈 문자열을 넣지 않는다 — '안 적음'과 '지웠음'을 구분할 필요가 없어 하나로 둔다 |

## 8. 데이터 저장 구조

```
public.support_applications          <- 접수의 정본. Mattermost 알림은 이 표의 사본일 뿐이다
  +- index support_applications_by_created (created_at desc)
  +- RLS on · 정책 0개  <- service_role Edge Function + SECURITY DEFINER RPC만 접근

public.application_sms               <- 결과 안내 문자 장부
  +- FK application_id -> support_applications(id) ON DELETE CASCADE
  +- unique index application_sms_once (application_id, kind)
  |       WHERE status NOT IN ('failed','superseded')
  +- index application_sms_by_application (application_id)
  +- RLS on · 정책 0개

cron.job 'support-applications-purge'  '31 4 * * *'
  delete from support_applications where created_at < now() - interval '1 year'
```

- **부분 유니크 인덱스가 중복 발송을 막는 유일한 장치다.** '보내기 전에 이미 보냈나 확인'은 두 호출이
  나란히 통과한다 — 그래서 **자리를 먼저 선점**(insert)하고 보낸다.
- **키에 `kind`가 들어가야 한다.** `(application_id)` 단독이면 보류 문자를 받은 사람이 나중에 선정됐을 때
  선정 문자가 안 나간다. `reservation_sms`와 같은 방식이되 키가 다른 이유가 이것이다.
- **`failed`·`superseded`는 자리를 비운다** — 재시도와 수동 발송 기록이 들어올 수 있어야 한다.
- **문자 장부를 `reservation_sms`와 나눴다.** 저기는 `reservation_id`에 FK가 걸려 있어 신청서를 가리킬 수 없다.
  컬럼을 nullable로 풀어 섞으면 '예약도 신청도 아닌 행'이 생기고, 그때부터 어느 쪽 화면도 그 행을 책임지지 않는다.
- **보유기간 1년을 실제로 집행하는 것은 이 크론뿐이다.** `apply.html`의 동의 문구와 어드민 탭의 안내는
  그 크론을 사람에게 설명하는 문장이다. CCTV 보관기간과 똑같은 구조라 함정도 똑같다 —
  **한쪽만 고치면 신청자에게 한 약속과 실제가 어긋난다.** 행째 삭제이므로 `application_sms`도 cascade로 함께 사라진다.

## 9. 기술 구현

### 모듈 구조

```
supabase/functions/apply/
  index.ts        <- HTTP 표면만: CORS · action 분기 · 어드민 판정 · 직렬화
  validate.ts     <- 순수. 브라우저가 보낸 것을 저장해도 되는 값으로 바꾸거나 거절
  store.ts        <- service_role 클라이언트 · insert · markNotified
  message.ts      <- 순수. 신청 한 건 -> Mattermost 한 통(표 조립·이스케이프)
  notify.ts       <- 웹훅 발송. 어떤 예외도 밖으로 던지지 않는다
  decide.ts       <- 상태 저장 -> dispatch 호출(순서 계약이 사는 곳)
  dispatch.ts     <- 선점 -> 발송 -> 기록. markManual
  templates.ts    <- 순수. 결과 문구의 정본
  errors.ts       <- HandlerError(status, message)

06-applications/
  apply.html      <- 공개 신청 폼(단독 배포물)
  admin.html      <- #view-applications 섹션 + #decideModal + 관련 JS
```

**순수/부수효과를 파일 경계로 나눈 이유**는 테스트다. `validate`·`message`·`templates`는 네트워크도 DB도 없어
검증·조립·문구 규칙이 전부 로컬에서 돈다(`deno test`, 24개).

### 접수 경로 (`submit`)

```
index.ts
  +- validate(body)
  |     +- ok:false      -> 400 + 한국어 문구
  |     +- ok:true,spam  -> 200 {ok:true}  <- 저장·알림 없음
  +- insert(sb, value, at)          실패 -> 500 "접수 중 오류가..."
  +- notify(value, at)              실패 -> 로그만. 응답은 성공
  +- markNotified(sb, id, at)       실패 -> 로그만(접수는 유효)
```

`markNotified` 실패를 삼키는 것도 의도다 — 표시가 못 붙으면 나중에 '알림 못 간 건'으로 한 번 더 보일 뿐이고,
그건 반대(못 갔는데 갔다고 적힘)보다 훨씬 낫다.

### 결정 경로 (`decide`)

```
decide.ts
  +- fetchApplication(id)           없으면 404
  +- update status/decided_at/admin_memo   실패 -> throw(500)
  +- dispatch(sb, app, kind)
        +- render(kind)             <- 문구는 항상 서버가 만든다. 호출측이 본문을 넘기지 못한다
        +- loadConfig() null        -> not_configured (장부에 안 적는다)
        +- normalizePhone null      -> claim(to=null) -> finish(no_phone) -> 본문 반환
        +- claim(to, body)          -> null이면 already (23505 = 유니크 위반)
        +- send(cfg, to, body)
        |     +- ok    -> finish(sent, sent_at, group_id)
        |     +- !ok   -> finish(failed, error) + 본문 반환
        +- DispatchResult
```

**문구를 서버 한 곳에서만 만드는 것**이 "어드민이 미리 본 문장 = 손님이 받는 문장"의 유일한 보장이다.
어드민이 문구를 조립하면 그 순간 확인 절차는 승인 장치가 아니라 장식이 된다.

`markManual`은 기존 행을 `superseded`로 내리고 **새 행을 만든다** — 이미 있는 행을 고쳐 쓰지 않는다.
그러면 장부가 '실패했는데 성공으로 적힌' 거짓말을 하게 된다(`reservation_sms`와 같은 규칙).

### 문구의 정본 (`templates.ts`)

`selected`·`held` 두 벌. 상수로 뽑아 한 곳에서만 적는 값: 연락처, 예약 링크(스페이스클라우드),
페이백 링크(`/payback`), 지원 상한 12시간, 후원 크레딧 문장.

문구 규칙(2026-08-10 형운 승인본):

- 후원 크레딧은 **본문 끝, 연락처 바로 위** — 맨 앞에 두면 누가 보낸 문자인지 흐려진다
- 12시간 상한은 **예약 링크 바로 아래** — 예약을 누르기 직전에 읽어야 하는 정보다
- "한 번에 쓰셔도 되고 나눠서 쓰셔도 됩니다"가 없으면 12시간을 한 번에 다 써야 하는 것으로 읽는 사람이 생긴다
- 선정 문구에 "예약 시 본인 결제 → 이용 후 환급(3.3% 공제)" 문단이 없으면 "지원인데 왜 내가 결제하지?"로 문의가 몰린다
- 보류 문구의 "다시 신청하지 않으셔도 됩니다"가 없으면 중복 신청이 쌓인다
- 이용 기한은 문자에 넣지 않는다 — 공지로 안내한다(형운 결정)

**12시간 상한을 강제하는 코드는 어디에도 없다.** 예약은 스페이스클라우드에서 이뤄져 우리 DB를 지나지 않는다.
상한은 문구로 알리고 지원금 신청 단계에서 사람이 대조한다 — 강제하려면 예약과 신청자를 잇는 키가 필요한데
지금은 이름·연락처 대조가 전부다.

### 테스트 (`deno test supabase/functions/apply/`)

| 파일 | 개수 | 무엇을 지키나 |
|---|---|---|
| `validate.test.ts` | 10 | 동의 `"true"` 문자열 거절 · 덫이 다른 검증보다 앞 · 길이는 자르지 않고 거절 · 인스타 정규화 |
| `message.test.ts` | 6 | 파이프·줄바꿈을 넣어도 표가 안 깨짐 · 이상한 핸들은 링크로 안 만듦 · 목적은 여러 줄 인용 |
| `templates.test.ts` | 8 | 선정 4단계·링크·12시간·환급 구조 · 보류에 예약/페이백 링크 없음 · 두 문구 모두 후원 크레딧·연락처·LMS 상한 |

## 10. API 엔드포인트

### Edge Function — `POST /functions/v1/apply`

`Authorization: Bearer <anon key>` + `Content-Type: application/json`. 응답은 항상 JSON.

| action | 권한 | 요청 본문 | 응답 |
|---|---|---|---|
| (없음) · `submit` | 공개 | `name` `phone` `email` `instagram` `purpose` `consent` `website` | `{ok:true}` / 400 `{error}` / 500 `{error}` |
| `preview` | 어드민 | `password` `decision`(또는 `kind`) | `{body}` — DB를 건드리지 않는다 |
| `decide` | 어드민 | `password` `id` `decision` `memo` | `{status, detail?, body?}` |
| `mark_manual` | 어드민 | `password` `id` `decision` | `{ok:true}` |

공통 오류: `405`(POST 아님) · `400`(JSON 아님 / 알 수 없는 action / 알 수 없는 결과 / id 없음) ·
`401`(비밀번호 불일치) · `429`(시도 제한) · `503`(`ADMIN_PASSWORD` 미설정) · `404`(신청 없음) · `500`(그 외).

`decision`과 `kind` 둘 다 받는 이유는 어드민 호출이 `decision`을 쓰고 장부 컬럼이 `kind`라서다 —
`parseKind`가 둘을 하나로 받아 화이트리스트(`['selected','held']`)로 자른다.

### PostgREST RPC (어드민 조회)

| 함수 | 인자 | 반환 |
|---|---|---|
| `admin_list_applications` | `p_password` | `setof support_applications` (created_at 최신순) |
| `admin_list_application_sms` | `p_password` | `setof application_sms` (created_at 오름차순) |

- `setof support_applications`인 이유: 나중에 컬럼이 붙어도 자동으로 실려 나간다 — 실제로 `status`·`decided_at`·
  `admin_memo`가 나중에 붙었을 때 이 함수를 고칠 필요가 없었다(그 형태를 고른 이유가 이것이다).
- 최신순인 이유: 신청은 예약과 달리 '오늘 무엇이 있나'가 아니라 '새로 뭐가 들어왔나'로 읽는 목록이라,
  화면이 정렬을 다시 하지 않아도 맨 위가 방금 들어온 것이어야 한다.

### 알려진 빈틈

| 항목 | 내용 |
|---|---|
| 공개 submit 유량 제한 | 없다. 시도 제한(`throttle`)은 어드민 인증 실패만 센다 — 봇이 덫을 피해 폼을 반복 제출하면 막을 장치가 없다 |
| 서버측 중복 제출 방어 | 없다. 같은 사람이 두 번 보내면 행이 둘 생긴다. 클라이언트 버튼 잠금이 유일한 방어다 |
| RPC 경로 시도 제한 | `admin_list_applications`는 PostgREST를 타 Edge Function의 시도 제한 밖이다(`spec_admin_auth`) |

## 11. 의존성

| 대상 | 무엇을 의존하나 |
|---|---|
| `spec_admin_auth` | `ADMIN_PASSWORD` · `constantTimeEqual` · `cf-connecting-ip` 시도 제한 · `admin_list_reservations`(비밀번호 검증 위임) |
| `spec_payback_claim` | 선정자가 이용 후 밟는 다음 단계. 선정 문구의 `/payback` 링크가 그 접점이다 |
| `spec_guest_sms` | `control/sms/solapi.ts`(`loadConfig`·`normalizePhone`·`send`)를 공유한다. 그 파일이 바뀌면 결과 문자도 함께 영향받는다 |
| `nmwc-brand-system` | 후원 배너의 NMWC 마크는 `nmwc-logo.svg`(Primary Mark · 4-step Pill Stack) 원본을 인라인한 것. ANTIEGG 마크는 `antiegg-backoffice/public/logos/icon-dark.svg` |
| `03-identity/design-tokens.md` | 색·타이포 정본. `apply.html`은 빌드 단계가 없어 토큰 값을 각 파일이 따라 적는다 |

## 12. 관련 스펙 변경

| 스펙 | 변경 내용 |
|---|---|
| `spec_admin_auth` | 시도 제한 배선 대상에 `apply`가 포함된다(`AuthSurface`에 `'apply'`) |
| `spec_payback_claim` | 어드민 사이드바에 "공간 지원 신청"과 "지원금 신청"이 나란히 놓인다. 두 탭은 데이터가 이어지지 않고 사람이 이름·연락처로 대조한다 |

## 파일(페이지) 구성

| 파일 | 경로 | 설명 |
| --- | --- | --- |
| `apply.html` | `06-applications/apply.html` | 공개 신청 폼. 히어로·안내·후원 배너·5칸 폼·스팸 덫·동의·완료 화면 |
| `admin.html` | `06-applications/admin.html` | 어드민. `#view-applications` 섹션 · `#decideModal` · 렌더/결정 JS |
| `index.ts` | `supabase/functions/apply/index.ts` | HTTP 표면. CORS·action 분기·어드민 판정·시도 제한 |
| `validate.ts` | `supabase/functions/apply/validate.ts` | 입력 검증(순수). 덫·동의·필수·형식·길이 |
| `store.ts` | `supabase/functions/apply/store.ts` | service_role 클라이언트 · `insert` · `markNotified` |
| `message.ts` | `supabase/functions/apply/message.ts` | Mattermost 본문 조립(순수). 표 이스케이프·핸들 링크 판정 |
| `notify.ts` | `supabase/functions/apply/notify.ts` | 웹훅 발송. 예외를 밖으로 던지지 않는다 |
| `decide.ts` | `supabase/functions/apply/decide.ts` | 상태 저장 → 발송 순서 계약 |
| `dispatch.ts` | `supabase/functions/apply/dispatch.ts` | 선점→발송→기록 · `markManual` |
| `templates.ts` | `supabase/functions/apply/templates.ts` | 결과 문구의 정본(순수) |
| `errors.ts` | `supabase/functions/apply/errors.ts` | `HandlerError(status, message)` |
| `validate.test.ts` · `message.test.ts` · `templates.test.ts` | `supabase/functions/apply/` | 단위 테스트 24개(DB·웹훅 불필요) |
| `README.md` | `supabase/functions/apply/README.md` | 왜 이렇게 동작하는지 · 시크릿 · 배포 · 미검증 항목 |
| `20260810000000_support_applications.sql` | `supabase/migrations/` | 테이블 · RLS · 인덱스 · 보유 1년 크론 |
| `20260810100000_admin_list_applications.sql` | `supabase/migrations/` | `admin_list_applications` RPC |
| `20260810220000_application_selection.sql` | `supabase/migrations/` | `status`·`decided_at`·`admin_memo` · `application_sms` · `admin_list_application_sms` |

## 13. 미확인 항목

| 항목 | 내용 |
|---|---|
| Mattermost 실제 렌더 | 표·인용 블록이 채널에서 의도대로 보이는지는 한 통을 받아봐야 안다. 접수 왕복 자체는 2026-08-10 배포 직후 실제 1건으로 확인했고(행 생성·핸들 정리·`notified_at`) 그 행은 지웠다 |
| 어드민 신청 탭 실물 클릭 | RPC와 화면은 만들었지만 어드민 비밀번호를 쓰는 로그인까지는 사람만 밟을 수 있다. 선정·보류 → 미리보기 → 발송 왕복 미검증 |
| 결과 문자 실발송 | [확인 필요: `apply` 경로로 SOLAPI 발송이 라이브에서 성공한 적이 있는지. `control/sms`는 검증됐지만 이 경로의 왕복 기록은 없다] |
| 안내 문구·noindex | `apply.html`은 지금 `noindex`다. 프로그램 내용(지원 대상·혜택·심사·마감)이 확정돼 `.intro`가 채워지면 그 줄을 지운다 — [확인 필요: 확정 시점] |
| 보유기간 1년 | [확인 필요: 세무상 필요 보유기간과 1년이 어긋나지 않는지. 어긋나면 크론·동의 문구·어드민 안내를 함께 고쳐야 한다] |
| `MATTERMOST_APPLY_WEBHOOK_URL` | [확인 필요: 라이브에 이 전용 웹훅이 설정돼 있는지, 아니면 공용 채널로 가고 있는지] |

## 14. 변경 이력

| 날짜 | 변경 내용 |
| --- | --- |
| 2026-08-14 | 최초 작성 — 기존 구현(PR #64·#65·#66·#69)의 역기획 |
