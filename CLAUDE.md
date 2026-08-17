# space-brand-system — 작업 규칙

타입라운지(TYPE LOUNGE) 브랜드 시스템 + 무인 운영 시스템.
레포가 무엇이고 지금 어떤 상태인지는 [`README.md`](./README.md)에 있다. 이 문서는 **어떻게 고치는가**만 다룬다.

## 클론 위치 — 머신마다 다르다

**정본은 `origin/main`이다.** 로컬 체크아웃을 어디에 두느냐는 머신마다 다르고, 어느 한쪽이 다른 쪽의
'낡은 사본'이 아니다 — 둘 다 origin을 보고 있다.

| 머신 | 클론 위치 |
|---|---|
| 이 머신 (iCloud 동기 맥) | `Work/NMWC/Project/_core/space-brand-system` — **여기 하나뿐이다.** 한때 정본이라 적혀 있던 `~/Dev/space-brand-system` 사본은 2026-08-14에 제거됐다(고유 커밋 0 · 미커밋 0 · 앵커한 워크트리 0 확인 후) |
| 합정 현장 맥 | `~/Dev/space-brand-system` — iCloud 밖. 사유·설정은 아래 "현장 맥" 절 |

- **머신 간 동기화는 origin으로만 한다.** 한쪽에서 커밋·푸시하고 다른 쪽은 `git pull`. 파일을 복사해 옮기지 않는다.
- **⚠️ iCloud 경로의 위험은 그대로다.** 인자 없는 `git status`/`git commit`이 워킹트리 전체를 stat하는
  인덱스 refresh 단계에서 60초+ hang한다(2~3.5MB PNG 목업 여러 개 보유). dataless 스텁이 없는 상태에서도
  발생 — 흔한 "dataless라서 느리다" 진단으로는 안 잡힌다. **경로를 지정해 쓴다** — `git status --short -- .`
  처럼. 상세: 글로벌 메모리 `reference_icloud_dataless_git.md` 2026-08-03 항목.
- **커밋 신원**: 이 경로는 `Work/*` gitdir includeIf 안이라 `hyungwoon <hyungwoon.kr@gmail.com>`가 자동 적용된다
  (`Work/.gitconfig-nmwc`, 확인됨). 현장 맥의 `~/Dev`는 includeIf 밖이라 레포에 직접 박는다 — 아래 "현장 맥" 절.

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
| CCTV 보관기간 | `mediamtx.yml`의 `record`/`recordDeleteAfter` | **지금 서버는 녹화 안 함(`record: no`, 2026-08-10)** — 파기할 게 없어 recordDeleteAfter는 휴면이다. 영상은 카메라 SD카드에만 남고 **SD 보관은 감사 범위 밖**(오너 결정 2026-08-13, 경계=우리 서버). 서버 녹화를 다시 켜면 recordDeleteAfter가 파기 주체가 되고 그때 4곳을 맞춘다 |
| 기기 capabilities | ThinQ 기기 프로파일 | 클라이언트가 준 값·문서 예시 아님. 실기기와 세 군데가 달랐던 실측이 있다 |

`07-brand-book/`(brand·bx·signage·product)은 위 정본에서 **파생된** 문서다. 원본을 고치면 여기도 같이 고친다.

## 브랜드북은 md가 단일 소스다

`07-brand-book/site/`와 `public/brand`(→ `site/` 심링크)는 **빌드 산출물이다. 손으로 고치지 않는다.**
고칠 곳은 `07-brand-book/{brand,bx,signage,product}.md` 뿐이고, 그다음 반드시:

```
python 07-brand-book/build_book.py     # site/ 전체 + zip + standalone 재생성
```

사이트에만 있고 md에는 없는 내용을 만들면 **MD view 토글이 거짓말을 한다** — 그게 이 구조를 택한 이유다.
스와치·로고칩·픽토 그리드 같은 시각 요소는 md 안의 ` ```tl-* ` 펜스로 적는다(깃허브에서는 코드블록으로
조용히 표시되고, 빌드가 컴포넌트로 바꾼다). 블록 문법의 정본은 `build_book.py`의 각 `r_*` 함수 docstring이다.

`index.html`(구 수기 4탭 SPA)은 이관 대조용으로 남겨둔 이력이다 — 배포에는 쓰이지 않는다.
`PLAN.md`는 초기 계획의 이력이라 현재 상태의 근거로 쓰지 않는다.

## 절대 하면 안 되는 것

- **`main` 직접 푸시 금지.** 브랜치 → PR → 스쿼시 머지. 커밋은 `feat(admin):`·`docs(cctv):` 같은
  타입(스코프) + 한국어 제목.
- **시크릿 커밋 금지.** ThinQ PAT · Supabase service_role 키 · 스트림 계정/비번 ·
  Mattermost 웹훅 URL은 Supabase 시크릿 / Apps Script 스크립트 속성 / `.env`에만 둔다.
- **`public/` 안을 직접 고치지 않는다.** 그 안은 `06-applications/`의 페이지를 하나씩 가리키는 심링크다.
- **서버에 오디오를 들이지 않는다.** 카메라를 `mediamtx.yml`에 직접 소스로 걸지 않는다 — 오디오를
  떼는 ffmpeg `-an` 재발행(`camera-republish.sh`, 전 path `source: publisher`)이 유일 경로다. 직결하면
  오디오가 서버로 흐르고, 녹화를 켠 상태면 「개인정보 보호법」 §25⑤(녹음)이 된다. MediaMTX엔 오디오를
  버리는 설정이 없어 재발행이 유일한 방어다. 카메라 마이크 끄기·오디오 트랙 감지 경고도 방어선으로 둔다.
- **(서버 녹화를 켤 때) 보관기간을 한 곳만 고치지 않는다.** 4곳(`guest-guide.html` · 현장 안내판 ·
  `recordDeleteAfter` · 시크릿 `CAMERA_RETENTION_DAYS`)이 같은 숫자여야 한다. 지금은 `record: no`라 이
  동기화가 휴면이지만, 녹화를 다시 켜는 순간 조건이 되살아난다.
- **주민번호를 평문으로 두지 않는다.** 「개인정보 보호법」§24-2③의 강행 규정이다 — 동의를 받았다고
  갈음하지 못한다(수집 근거도 동의가 아니라 소득세법이다). 암호화는 DB가 아니라
  `functions/claim/crypto.ts`가 하고, 키는 Edge Function 시크릿에만 둔다 — **DB가 통째로 새도
  주민번호는 안 새는 것**이 그 구조의 목적이다. 평문 컬럼을 만들지 말 것 — 만들면 언젠가 채워진다.
- **주민번호·계좌번호를 Mattermost에 보내지 않는다.** `apply`의 알림은 신청 내용을 통째로 실어
  보내지만, `claim`은 그러면 안 된다 — 채널 글은 검색되고 전달되고 잠금화면에 뜨며, 우리가 정한
  파기 시점과 무관하게 남는다. 암호화해 넣고 같은 값을 평문으로 뿌리면 암호화한 의미가 없다.
- **지원금 지급 후 '지급 완료'를 꼭 누른다.** 주민번호 파기 크론이 `paid_at`에 매달려 있어,
  표시하지 않으면 보유기간을 넘어도 안 지워진다. 지급 안 할 건은 반려(→ 즉시 파기).
- **어드민 비밀번호를 공개 페이지에 넣지 않는다.** 그 값은 기기뿐 아니라 예약자 이름·연락처를 여는
  `admin_*` RPC의 열쇠다. 손님 페이지(`guest-control.html`)는 비밀번호가 없고(현관 비밀번호가
  이미 사이트 루트에 평문 공개라 게이트가 장벽이 아니었다), 할 수 있는 일은 서버(`auth.ts`)가
  자른다 — 클라이언트에서 버튼을 감추는 건 방어가 아니다.
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
