# 합정 맥 온사이트 핸드오프

> **읽는 대상: 합정 상주 맥에서 처음부터 세팅하는 세션.**
>
> 절차 자체는 [`control-setup.md`](./control-setup.md)(A·B)와 [`cctv-setup.md`](./cctv-setup.md)(C)에 있다.
> **이 문서는 그걸 대체하지 않는다.** 어디서 시작하고, 뭐가 이미 끝났고, 뭘 다시 결정하면 안 되는지만 말한다.
> 절차를 밟을 때는 반드시 저 두 문서를 열어서 본다.

작성: 2026-08-03 · 서버 쪽 작업은 다른 맥에서 이미 끝냈다.

---

## 1. 지금 상태

### 이미 끝난 것 — **다시 하지 않는다**

| | 상태 |
|---|---|
| DB 마이그레이션 | `devices`·`device_state`·`device_commands`·`cameras`·`camera_state` 전부 적용됨 |
| Edge Function `control` | 배포됨. 카메라 액션(`cameras`/`camera_register`/`camera_delete`/`camera_credentials`) 포함 |
| Supabase 시크릿 | `ADMIN_PASSWORD` + `CAMERA_*` 5개 설정 완료 |
| Vercel | `https://typelounge.vercel.app/admin` 라이브. guest-guide는 `/` |
| Cloudflare | `nmwc.ai.kr` Active(Free). **DNS 레코드는 아직 없다** — C-6에서 만든다 |

`supabase db push`·`functions deploy`·`secrets set`을 **다시 돌릴 이유가 없다.** 돌리지 마라.

### 아직 아무것도 안 된 것

**이 맥 전부.** brew 패키지(mosquitto·mediamtx·cloudflared·node)·에이전트·터널 다 없다.
오늘 밤 할 일이 이것 전부다.

### 오늘 못 하는 것 (없어서)

| | 왜 | 대신 |
|---|---|---|
| 카메라 | 아직 안 샀다 | **C-4b**의 가짜 스트림으로 전 구간을 대신 검증한다 |
| 냉난방(A) | ThinQ PAT 미발급 | 오늘 범위 밖. A는 맥과 무관하니 아무 때나 된다 |
| 조명 기기 등록(B-5·B-6) | Tasmota 기기 상태 미확인 | 기기가 없으면 B-4까지만 하고 멈춘다 (그래도 의미 있다 — 아래 참조) |

---

## 2. 오늘 밤의 목표

```
0. 공통 준비   맥이 안 자게 · IP 고정 · repo · Node          ~20분
1. B. 조명     mosquitto + 에이전트                          ~30분
2. C. CCTV     MediaMTX + cloudflared                        ~40분
3. C-4b        가짜 스트림으로 전 구간 검증  ← 오늘의 하이라이트  ~30분
```

**C-4b까지 가면 "카메라를 꽂기만 하면 되는 상태"가 된다.** 그게 오늘의 성공 기준이다.
조명 기기가 아직 없어도 에이전트까지 띄워두면 나중에 기기만 붙이면 되므로 B-4까지는 해둔다.

시간이 모자라면 **C를 먼저 한다.** B는 기기가 있어야 끝나지만 C는 오늘 안에 완결되기 때문이다.

> 단 C를 먼저 하더라도 **B-4의 앞부분(`npm install` + `.env` 작성)은 해야 한다.** C-8이 그
> `.env`에 한 줄을 더하는 것이라, 파일이 없으면 어드민에 녹화 상태가 영영 안 뜬다.
> mosquitto(B-3)는 그때 건너뛰어도 된다 — 에이전트는 브로커에 못 붙어도 재접속을 계속 시도할 뿐
> CCTV 보고는 정상으로 돈다(`connectMqtt`가 던지지 않고 그 뒤에서 `startCameraReporter`가 돈다).
> 단 `MQTT_URL`은 설정 필수값이라 **`.env`에서 지우면 안 된다** — `.env.example`의 기본값
> (`mqtt://localhost:1883`)을 그대로 두면 된다.

---

## 3. 형운이 갖고 와야 하는 값 — 레포에 없다

**전부 비밀이라 커밋되지 않는다.** 없으면 그 단계에서 멈춘다.

| 값 | 어디서 | 어디에 쓰나 |
|---|---|---|
| Supabase **service_role** 키 | 대시보드 → Project Settings → API | 에이전트 `.env` (B-4) |
| **admin 비밀번호** | 형운 | admin.html 로그인 (B-6·C-4b) |
| **스트림 계정/비번** | 형운 (계정은 `typelounge-view`) | `mediamtx.yml` (C-4) |
| GitHub 접근 | `gh auth login` (계정 `hyungwoon`) | repo clone |

> ⚠️ **스트림 비번은 Supabase 시크릿에 이미 들어 있는 값과 글자까지 같아야 한다.**
> 새로 만들면 안 된다 — 만들었다면 `supabase secrets set CAMERA_STREAM_PASS=...`로 양쪽을 맞춰야
> 하고, 한쪽만 바꾸면 **영상이 통째로 안 나온다.**
>
> mosquitto 비번은 오늘 새로 정하는 값이라 갖고 올 필요 없다.

---

## 4. 공통 준비 (0단계)

### 4-1. 맥이 잠들지 않게 — **이거 먼저 한다**

에이전트가 자면 조명이 죽고, MediaMTX가 자면 녹화가 끊긴다. 노트북이면 덮개를 닫아도 안 자게.

```bash
sudo pmset -a sleep 0 disablesleep 1
pmset -g | grep -E 'sleep|disablesleep'
```

- [ ] 전원 어댑터를 연결한 상태로 둔다

### 4-2. repo

**iCloud 동기 폴더(`~/Documents`·`~/Desktop`) 아래에 두지 않는다.** 이 워크스페이스는 iCloud가
`.git`을 dataless로 만들어 `git log`가 무한 대기하고 worklog가 조용히 스킵되는 사고를 이미 겪었다.

```bash
mkdir -p ~/Dev && cd ~/Dev
gh auth login            # 계정: hyungwoon
gh repo clone nmwc-ai/space-brand-system
cd space-brand-system
```

`~/Dev`는 `Work/*` gitdir includeIf 밖이라 **커밋 신원이 자동으로 안 잡힌다.** 이 repo에서만 박아둔다:

```bash
git config user.name  "hyungwoon"
git config user.email "hyungwoon.kr@gmail.com"
```

### 4-3. Node

에이전트가 `--env-file`을 쓴다. **Node 20.6+ 필요.**

```bash
brew install node
node --version     # v20.6 이상
```

---

## 5. B. 조명 → [`control-setup.md`](./control-setup.md) **B단계**

그 문서를 그대로 따른다. 여기서는 함정만 짚는다.

- **B-2 IP 고정을 건너뛰지 마라.** DHCP로 맥 IP가 바뀌면 Tasmota가 못 붙어 **조명이 조용히 먹통**이 된다.
- **B-3에서 비밀번호 파일을 먼저 만든다.** 없으면 mosquitto가 시작에 실패한다 — 그게 정상이고,
  조용히 열린 채로 뜨는 것보다 낫다.
- **B-4에서 `[realtime] SUBSCRIBED`가 안 뜨면 거기서 멈춘다.** 이게 없으면 명령이 아예 안 온다.
- Tasmota 기기가 아직 없으면 **B-4까지만 하고 B-5·B-6은 건너뛴다.** 에이전트는 기기 0대로도
  정상 기동한다(`조명 기기 0대 로드`).
- **B-7(자동 시작)은 B-6 확인이 끝난 뒤에** 한다. 기기가 없어 B-6을 못 했으면 B-7은 나중에.

---

## 6. C. CCTV → [`cctv-setup.md`](./cctv-setup.md)

**C-0(법·고지)과 C-1~3(카메라)은 오늘 건너뛴다.** 카메라가 없다.
오늘은 **C-4 → C-6 → C-4b → C-8** 순서다. (C-7 서버 설정은 이미 끝났다.)

### 6-1. C-4 MediaMTX

- `mediamtx.yml`의 `<>` 자리를 전부 채운다. **하나라도 남기면 인증이 비어 누구나 볼 수 있다.**
- 카메라가 없으니 `paths:`의 `entrance` 블록은 **주석 처리하거나 그대로 둔다** — 소스에 못 붙어
  로그에 에러가 계속 찍히지만 서버는 정상이다. C-4b의 `testpattern`으로 확인할 것이다.
- `<녹화경로>`도 iCloud 밖으로. `~/typelounge-recordings` 권장.
- C-4의 로컬 확인은 `curl -u`로 한다. **브라우저 주소창에 `?user=&pass=`를 붙여도 안 된다** —
  MediaMTX가 v1.18.0에서 쿼리 자격증명을 막았다.

### 6-2. C-6 터널

- `cloudflared tunnel login` → 브라우저에서 **`nmwc.ai.kr`을 고른다**.
- **Zero Trust 대시보드에 들어가지 마라.** 유료 플랜 선택 화면이 뜨는데, CLI로 만드는
  locally-managed tunnel은 그 경로를 안 탄다. 기존 `nmwc-mattermost`도 같은 방식이다.
- 호스트네임은 **`cam.nmwc.ai.kr` / `camrec.nmwc.ai.kr`** 로 확정돼 있다(서버 시크릿이 이 값을
  가리킨다). 바꾸려면 Supabase 시크릿도 같이 바꿔야 한다.
- ⚠️ 와일드카드 `*.nmwc.ai.kr`이 이미 있어서, **터널이 안 붙으면 401이 아니라 Vercel 404가 온다.**
  "401이 나와야 정상"인 확인에서 404를 보면 DNS·터널부터 의심한다.

### 6-3. C-4b 전 구간 검증 — **오늘의 핵심**

ffmpeg 컬러바를 밀어넣어 admin→터널→MediaMTX→hls.js 인증을 통째로 밟는다.
**여기까지 통과하면 남는 미지수는 "카메라가 RTSP를 뱉는가" 하나뿐이다.**

오디오 경고 검증(sine 트랙)까지 하고, **정리 체크리스트를 반드시 밟는다** —
안 되돌리면 로컬 RTSP가 열린 채로 남고 가짜 카메라가 어드민에 남는다.

### 6-4. C-8 에이전트에 CCTV 설정 추가

`.env`에 `MEDIAMTX_RECORD_DIR`을 넣고 에이전트를 재시작한다. 이걸 해야 어드민에
`녹화 중`·`남은 용량`·`⚠ 오디오 트랙 감지`가 뜬다.

---

## 7. 넘어가면 안 되는 확인

건너뛰면 **나중에 조용히 터지는** 것들이다. 하나씩 눈으로 본다.

- [ ] `[realtime] SUBSCRIBED` (B-4) — 없으면 조명 명령이 안 온다
- [ ] MediaMTX 로컬 `curl -u` → **200**, 인증 없이 → **401** (C-4)
- [ ] 터널 외부망에서 인증 있으면 **200**, 없으면 **401** (C-6)
      ← **401이 안 나오면 전 인터넷에 공개된 것이다. 거기서 멈춘다.**
- [ ] admin에 컬러바가 뜬다 (C-4b)
- [ ] 오디오 섞으면 30초 안에 `⚠ 오디오 트랙 감지` (C-4b)
- [ ] C-4b 정리 체크리스트 전부 (RTSP 되돌리기·테스트 카메라 해제·녹화 폴더 삭제)
- [ ] 맥 재부팅 후에도 에이전트·cloudflared가 살아난다

---

## 8. 이 세션에서 **다시 결정하지 말 것**

이미 근거를 갖고 정해졌다. 배경은 각 파일 주석에 있다. 바꾸려면 그 주석부터 읽는다.

| 결정 | 왜 | 어디 |
|---|---|---|
| 자격증명은 **Authorization 헤더** | 쿼리스트링은 MediaMTX v1.18.0이 보안 결함으로 막았고 `internal`은 토큰을 안 본다 | `admin.html` `camAuthHeader` 주석 |
| 인증은 **MediaMTX 내장** | 외부 인증 서버는 세그먼트마다 맥→Supabase 왕복이 껴 재생이 덜컥거린다 | `handlers/cameras.ts` 머리 주석 |
| 보관 **7일** | 네 군데가 물려 있다(안내 페이지·안내판·`recordDeleteAfter`·시크릿) | `cctv-setup.md` C-0 |
| 녹화 소스 **stream1(고화질)** | 640x360은 분쟁 때 알아볼 수 없다. 용량이 문제면 그때 stream2로 | `mediamtx.yml` 녹화 절 |
| 호스트네임 **한 단계** | Free의 Universal SSL이 `*.nmwc.ai.kr`까지만 커버 | `cctv-setup.md` C-6 |
| **녹음 금지** | 개인정보 보호법 §25⑤. 설정으로 못 막아 감시가 유일한 방어 | `cctv-setup.md` C-2 |

---

## 9. 끝나고 할 것

- [ ] `cctv-setup.md`의 **"아직 검증 안 된 것"을 실제 결과로 갱신한다.** 오늘 C-4b를 통과했으면
      1번(hls.js ↔ MediaMTX 인증)은 더 이상 미검증이 아니다 — 그대로 두면 다음 사람이 같은 걸 또 의심한다.
- [ ] 막힌 지점이 있었으면 **"막혔을 때" 표에 한 줄 추가한다.** 오늘 겪은 게 가장 정확한 증상이다.
- [ ] `control-setup.md`의 "아직 검증 안 된 것"도 B를 돌렸으면 갱신한다.
- [ ] 커밋 → PR → 스쿼시 머지 (main 직접 푸시 금지, 이 repo는 PR 방식이다)
