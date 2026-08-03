# space-brand-system — 작업 규칙

타입라운지(TYPE LOUNGE) 브랜드 시스템 + 무인 운영 시스템.
레포가 무엇이고 지금 어떤 상태인지는 [`README.md`](./README.md)에 있다. 이 문서는 **어떻게 고치는가**만 다룬다.

## 정본 위치 (2026-08-03 이전)

**정본은 `~/Dev/space-brand-system`.** `Work/NMWC/Project/_core/space-brand-system`(iCloud 동기 경로)은
origin에서 새로 받은 **클론**일 뿐 — 거기서 작업하지 않는다.

- **이전 사유**: 이 경로가 iCloud "데스크탑·문서" 동기화 대상이라, 인자 없는 `git status`/`git commit`이
  워킹트리 전체를 stat하는 인덱스 refresh 단계에서 60초+ hang했다(2~3.5MB PNG 목업 여러 개 보유).
  dataless 스텁이 없는 상태에서도 발생 — 흔한 "dataless라서 느리다" 진단으로는 안 잡힌다.
  상세: 글로벌 메모리 `reference_icloud_dataless_git.md` 2026-08-03 항목.
- **커밋 신원**: `~/Dev`는 `Work/*` gitdir includeIf 밖이지만, 글로벌 기본값이 이미
  `hyungwoon <hyungwoon.kr@gmail.com>`라 별도 설정 불필요(확인됨).
- **NMWC 클론을 다시 정본으로 되돌리지 않는다.** 작업은 항상 `~/Dev/space-brand-system`에서, 커밋 후
  push하면 iCloud 클론은 `git pull`로만 따라온다.

## 이 레포의 성격

**문서가 곧 제품이다.** 브랜드 정본(`01`~`05`·`07`)은 사람이 읽는 결정문이고,
운영 코드(`06-applications/`·`supabase/`)는 실제로 손님을 받는 시스템이다.
둘을 한 레포에 둔 이유는 같은 사실 — 보관기간·요금·층고·용도 — 을 사이니지와 게스트 가이드와
어드민이 **동시에** 말해야 하기 때문이다. 떨어뜨려 놓으면 한쪽만 고쳐지고, 그 순간 손님에게
한 약속과 실제가 어긋난다.

## 진실의 원천 (충돌하면 이쪽이 이긴다)

| 주제 | 정본 | 주의 |
|---|---|---|
| 로고 | `03-identity/logo-system.md` | 2026-07-05 전면 개정. **심볼 없음**(레이어드 E 워드마크 단독). `logo-guidelines.md`와 시안 v2~v8의 심볼 서술은 폐기된 이력이다 |
| 폰트 | `03-identity/typography.md` | **Paperlogy 단일** · 400/600. Pretendard·League Spartan 서술은 폐기 |
| 컬러·토큰 | `03-identity/design-tokens.md` | 화이트·잉크·오렌지 3색. **raw hex 금지** — 토큰으로 지시한다 |
| 공간 사실 | `01-strategy/discovery.md` | 전용 **52.49㎡**가 정본. 스페이스클라우드 리스팅의 66.116㎡(20평)는 마케팅 표기다 |
| 용도 프레이밍 | 실판매 페이지 | 회의실 / 촬영 스튜디오 / 파티룸(모임). `WORK·CLASS·GATHER` 추상 타입명·픽토는 확정 자산이라 유지 |
| CCTV 보관기간 | `mediamtx.yml`의 `recordDeleteAfter` | **실제로 파기하는 유일한 주체.** 나머지 3곳은 그걸 사람에게 설명하는 문장이다 |
| 기기 capabilities | ThinQ 기기 프로파일 | 클라이언트가 준 값·문서 예시 아님. 실기기와 세 군데가 달랐던 실측이 있다 |

`07-brand-book/`(brand·bx·product)은 위 정본에서 **파생된** 문서다. 원본을 고치면 여기도 같이 고친다.
`PLAN.md`는 초기 계획의 이력이라 현재 상태의 근거로 쓰지 않는다.

## 절대 하면 안 되는 것

- **`main` 직접 푸시 금지.** 브랜치 → PR → 스쿼시 머지. 커밋은 `feat(admin):`·`docs(cctv):` 같은
  타입(스코프) + 한국어 제목.
- **시크릿 커밋 금지.** ThinQ PAT · Supabase service_role 키 · 스트림 계정/비번 ·
  Mattermost 웹훅 URL은 Supabase 시크릿 / Apps Script 스크립트 속성 / `.env`에만 둔다.
- **`public/` 안을 직접 고치지 않는다.** `06-applications/`를 가리키는 심링크다.
- **CCTV 녹음 금지.** 「개인정보 보호법」 §25⑤ 위반이고 MediaMTX 설정으로는 못 막는다 —
  카메라에서 마이크를 끄고 VLC로 눈으로 확인하는 것만이 유일한 방어다.
- **보관기간을 한 곳만 고치지 않는다.** 4곳(`guest-guide.html` · 현장 안내판 ·
  `recordDeleteAfter` · 시크릿 `CAMERA_RETENTION_DAYS`)이 같은 숫자여야 한다.
- **`power = null`('모름')을 `'OFF'`로 합치지 않는다.** 합치면 냉난방이 밤새 돌아가는 상황이
  조용히 숨는다. 같은 이유로 `updated_at` 기본값을 `now()`로 주지 않는다.
- **ThinQ PAT 401을 재시도하지 않는다.** 자동 재발급 경로가 없고 계정 잠금 위험만 만든다.

각 하위 README의 "절대 되돌리면 안 되는 것" 절에 이유가 실측과 함께 남아 있다. 바꾸려면 그것부터 읽는다.

## 설치·현장 절차는 한 군데에만 둔다

절차의 정본은 `06-applications/control-setup.md`(A 냉난방 · B 조명)와 `cctv-setup.md`(C)다.
`control-agent/README.md`·`functions/control/README.md`는 **왜 그렇게 동작하는지**만 다룬다 —
절차를 양쪽에 복사하면 한쪽만 고쳐져 현장에서 조용히 어긋난다.

현장 맥에서 처음 세팅하는 세션은 `06-applications/onsite-handoff.md`부터 읽는다.

## 현장 맥 (합정 상주)

- 레포는 **`~/Dev` 아래**에 클론한다. iCloud 동기 폴더(`~/Documents`·`~/Desktop`)에 두면
  `.git`이 dataless가 돼 `git log`가 무한 대기한다(이 워크스페이스가 이미 겪은 사고다).
- `~/Dev`는 `Work/*` gitdir includeIf 밖이라 커밋 신원이 자동으로 안 잡힌다. 레포에 직접 박는다:
  `hyungwoon` / `hyungwoon.kr@gmail.com`.
- 녹화 경로도 iCloud 밖으로(`~/typelounge-recordings`). 동기화가 세그먼트를 계속 업로드한다.

## 검증

- 운영 코드를 고쳤으면 **어드민에서 실제로 눌러본다.** 조명·CCTV는 현장 맥과 실기기가 있어야
  끝까지 확인되므로, 확인 못 한 부분은 각 문서의 **"아직 검증 안 된 것"** 절에 남긴다.
- 현장에서 막혔던 증상은 그 문서의 **"막혔을 때"** 표에 한 줄 추가한다. 겪은 사람의 증상이
  가장 정확하고, 안 적으면 다음 사람이 같은 걸 다시 의심한다.
