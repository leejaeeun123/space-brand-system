# 공간 지원 프로그램 신청 접수

`apply.html`(`/apply`)이 쓰는 Edge Function. 하는 일은 하나다 — **신청을 장부에 넣고,
Mattermost로 알린다.**

## 왜 `control`과 따로인가

`control`에서 비밀번호를 안 보낸 요청은 `guest`고, guest의 모든 action은 **예약 시간
안에서만** 열린다(`control/reservation-window.ts`). 신청은 아무 때나 들어와야 하므로 저기에
넣으려면 그 게이트에 예외를 뚫어야 하는데, 그 게이트는 지나가던 사람이 이용 중인 손님의
기기를 못 건드리게 막는 장치다. 예외가 하나 생기는 순간 "손님 경로는 예약 시간에만 열린다"는
문장이 더 이상 참이 아니게 되고, 읽는 사람마다 다르게 이해하기 시작한다.

제어와 접수는 등급이 다른 일이라 HTTP 표면을 따로 뒀다.

## 왜 서버가 필요한가 (편의가 아니라 필수)

`apply.html`은 소스가 그대로 공개된다. 브라우저가 DB에 직접 쓰게 하려면 `support_applications`에
anon insert 정책을 열어야 하는데, 그러면 검증도 스팸 덫도 우회된다. 읽기 정책은 더 나쁘다 —
누구나 신청자 전원의 이름·연락처·이메일을 긁어간다.

그래서 테이블은 RLS를 켜되 **정책을 하나도 만들지 않았다**(`devices`·`reservation_sms`와 같은
방식). service_role로 붙는 이 함수가 유일한 접근 경로다.

## 순서가 계약이다 — 저장 먼저, 알림 나중

```
검증(validate.ts) → 저장(store.ts) → 알림(notify.ts) → notified_at 표시
```

뒤집으면 웹훅이 죽어 있던 동안의 신청이 통째로 사라지고, 신청자는 보냈다고 믿는다.
그래서 **저장 실패는 500으로 답하고, 알림 실패는 성공으로 답한다.** 신청자는 이미 다 적어서
보냈고, 우리 채널 사정은 그 사람 책임이 아니다.

못 간 알림은 `support_applications.notified_at`이 null로 남아 드러난다. 재시도 큐는 없다 —
`control/automation/notify.ts`의 선점·되돌리기 장치는 기기 이벤트가 초당 여러 건씩 쌓이기
때문에 있는 것이고, 신청은 하루 몇 건짜리 단발이다.

## 검증 (`validate.ts`)

| 칸 | 규칙 |
|---|---|
| `name` · `phone` · `email` · `purpose` | 필수 |
| `instagram` | 선택. `@`·프로필 URL을 벗겨 핸들만 저장한다 |
| `consent` | **`=== true`여야 한다.** 체크박스는 화면 장치일 뿐이라 `fetch`로는 그냥 빠진다 |
| `website` | 스팸 덫. 화면 밖에 있는 칸이라 사람은 못 채운다 |

길이는 **자르지 않고 거절한다** — 조용히 자르면 신청자는 다 보냈다고 믿는데 우리는 잘린 것을
읽고, 잘렸다는 사실이 아무 데도 안 남는다. `purpose`의 1000자는 DB 위생이 아니라 **Mattermost
4000자 상한을 지키는 실질적 장치**다(알림 한 통에 신청 하나가 통째로 들어간다).

스팸으로 판정하면 저장도 알림도 하지 않지만 **성공으로 답한다.** 400을 주면 보낸 쪽이 덫의
존재를 알아채고 다음엔 피해 간다.

## 시크릿

| 이름 | 필요 | 없으면 |
|---|---|---|
| `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` | 필수 | Supabase가 자동 주입한다 |
| `MATTERMOST_WEBHOOK_URL` | 사실상 필수 | 접수는 되고 알림만 안 간다(`notified_at`이 null로 남는다) |
| `MATTERMOST_APPLY_WEBHOOK_URL` | 선택 | 없으면 위 채널로 간다 |

신청 알림이 다른 알림을 덮으면 **코드를 고치지 않고** `MATTERMOST_APPLY_WEBHOOK_URL`만 넣어
분리한다(예약·기기 알림과 같은 방식, 2026-08-07 형운 결정).

## 배포

```bash
supabase db push                        # 테이블 + 보유기간 정리 크론
supabase functions deploy apply         # 이 함수
deno test supabase/functions/apply/     # 검증·조립 규칙 (DB·웹훅 불필요)
```

`apply.html`은 `main` 머지 시 GitHub Actions가 Vercel로 올린다. **함수와 마이그레이션은
자동 배포가 아니다** — 위 두 줄을 사람이 돌려야 한다.

## 보유기간을 한 곳만 고치지 않는다

동의 문구의 **1년**을 실제로 집행하는 것은 마이그레이션의 `support-applications-purge` 크론
하나뿐이다. `apply.html`의 문구는 그 크론을 사람에게 설명하는 문장이다. CCTV 보관기간과 똑같은
구조이므로 함정도 똑같다 — 한쪽만 고치면 신청자에게 한 약속과 실제가 어긋난다.

## 아직 검증 안 된 것

- **Mattermost 실제 렌더.** 표·인용 블록이 채널에서 의도대로 보이는지는 한 통을 받아봐야 안다.
  (접수 왕복 자체는 2026-08-10 배포 직후 한 건을 실제로 보내 확인했다 — 행 생성·핸들 정리·
  `notified_at` 까지. 확인 후 그 행은 지웠다.)
- **어드민 신청 탭의 실물 클릭.** `admin_list_applications` RPC와 화면은 만들었지만,
  어드민 비밀번호를 쓰는 로그인까지는 사람만 밟을 수 있다.
