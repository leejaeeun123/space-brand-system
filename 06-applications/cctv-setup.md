# CCTV 설치 체크리스트

> **합정 맥에서 처음부터 세팅하는 중이라면 [`onsite-handoff.md`](./onsite-handoff.md)를 먼저 읽는다.**
> 뭐가 이미 끝났고 오늘 뭘 건너뛰는지가 거기 있다. 이 문서는 절차만 담는다.
>
> 냉난방·조명은 [`control-setup.md`](./control-setup.md)에 있다. 이 문서는 **C. CCTV**만 다룬다.
> 설계 배경은 [`control-agent/mediamtx/mediamtx.yml`](./control-agent/mediamtx/mediamtx.yml)의
> 주석과 [`supabase/functions/control/handlers/cameras.ts`](../supabase/functions/control/handlers/cameras.ts)에 있다.

```
Tapo ──RTSP(LAN)──> [MediaMTX] ──HLS/재생──> cloudflared ──> admin.html
     (합정 LAN)      (합정 맥)   └─> 디스크(fMP4)      (아웃바운드만)

                     [에이전트] ──상태만──> Supabase ──> admin.html
```

**영상은 Supabase를 지나가지 않는다.** 서버가 아는 건 '카메라가 몇 대 있고 살아 있나'뿐이고,
프레임은 브라우저가 합정 맥에서 직접 받는다. 초당 수 Mbps를 Edge Function으로 중계하는 건
기술적으로도 비용상으로도 성립하지 않는다.

조명(B)과 같은 맥을 쓰지만 **서로 독립이다.** MediaMTX가 죽어도 조명은 돌고, 그 반대도 같다.

| | 어디서 | 걸리는 시간 | 선행 조건 |
|---|---|---|---|
| **C-0. 법·고지** | 책상 | ~1시간 | — |
| **C-1~3. 카메라** | 합정 현장 | ~40분 | 카메라 구매 |
| **C-4~6. 맥·터널** | 합정 맥 | ~60분 | **Cloudflare에 올라간 도메인** |
| **C-7~9. 서버·어드민** | 어디서나 | ~20분 | 위가 끝난 뒤 |

---

## C-0. 법·고지 — 이걸 먼저 한다

기술보다 여기가 먼저 막힌다. 파티룸 CCTV는 2017년 대중매체 이슈가 됐고, 그 뒤
**스페이스클라우드 호스트 운영정책에 〈영상정보처리기기 설치 및 관리〉 항목이 들어가 있다.**
안내문 양식도 플랫폼이 배포한다.

- [ ] **안내판 부착** — 설치목적·장소, 촬영범위·시간, 관리책임자 성명·연락처.
      `04-signage/`의 사이니지 체계에 편입한다. 손님이 들어와서 알아차리는 게 아니라
      **들어오기 전에 알 수 있어야** 한다.
- [x] **`guest-guide.html`에 고지 추가** — `#cctv` 섹션. 「개인정보 보호법」 제25조·시행령
      제24조의 필수 기재사항(설치 목적·장소, 촬영 범위·시간, 관리책임자 연락처)을 담았다.
- [ ] **스페이스클라우드 리스팅 유의사항에도 같은 내용 추가.** 숨겼다가 발견되는 게 최악이고,
      guest-guide는 이미 예약한 사람만 본다 — **예약 전에 알 수 있어야** 한다.
- [ ] **촬영범위 = 출입구 + 실내 라운지, 카메라 2대.** 화장실은 절대 불가 — 화각에 걸리면
      카메라를 옮긴다. 실내 라운지는 손님이 몇 시간을 머무는 곳이라 출입구보다 저항이 크다.
      그래서 세 가지로 상쇄한다: 목적을 범죄예방·시설안전으로 **한정**하고, **예약 전에**
      알 수 있게 리스팅까지 고지를 올리고, 실시간으로 지켜보지 않고 **사건이 있을 때만 열람**한다.
- [ ] **보관기간을 정한다.** 법정 일수는 없다 — 목적 달성 최소기간이고, 산정이 곤란하면
      30일 이내 권고다. 짧은 쪽이 법적으로 더 안전하다. 기본값은 7일이다(C-5 용량 계산 참조).

      정한 값은 **네 군데가 같아야 한다.** 어긋나면 손님에게 약속한 기간과 실제 보관 기간이
      달라지고, 그건 어느 쪽으로 어긋나든 문제다(짧으면 없는 영상을 약속한 것이고, 길면
      지운다고 해놓고 갖고 있는 것이다):

      | # | 어디 | 무엇 |
      |---|---|---|
      | 1 | `06-applications/guest-guide.html` | `#cctv` 섹션의 `보관 기간` |
      | 2 | 현장 안내판 | 인쇄물 |
      | 3 | `control-agent/mediamtx/mediamtx.yml` | `recordDeleteAfter` (실제로 지우는 주체) |
      | 4 | Supabase 시크릿 | `CAMERA_RETENTION_DAYS` (어드민 표시용) |

      실제로 파기를 집행하는 건 **3번 하나뿐**이다. 나머지 셋은 그걸 사람에게 설명하는
      문장이라, 3번을 바꾸고 나머지를 안 고치면 조용히 거짓말이 된다.

> 20인 파티·촬영 공간이라 "실시간으로 지켜본다"는 인상은 예약 전환에 마이너스다.
> 문구도 실제 열람도 범죄예방·시설안전에 한정한다.

---

## C-1. 카메라

**RTSP가 되는 상시전원 실내 모델만 산다.**

여기서 갈리는 건 **전원 방식이지 네트워크가 아니다.** Tapo 실내 카메라는 애초에 이더넷 포트가
없어 전부 Wi-Fi로 붙는다. 문제는 **배터리 모델에 RTSP가 아예 없다**는 것이다(C410·C420·C425·
D230). 벤더 클라우드 전용 기종도 앱 밖으로 영상을 못 빼 실격이다.

- [ ] Tapo 상시전원 실내 모델 **2대**. 비 안 맞는 곳에만 다니 방수는 필요 없다.
- [ ] **SD카드도 2장 산다.** 아래를 보면 선택이 아니다.
- [ ] 자리는 둘이다 — **출입구가 보이는 위치**(스트림 `entrance`)와 **라운지 전체가 보이는
      위치**(스트림 `lounge`). 둘 다 콘센트가 닿는지 먼저 보고, **화장실이 화각에 들어가면
      각도를 바꾼다**(C-0).

### Wi-Fi로 붙는다는 것의 실제 위험

Tapo 실내 주력(C210·C225)은 **2.4GHz 전용**이다(5GHz는 C260·C460·C840 등 일부). 이 공간엔
게스트 Wi-Fi가 있고 20명이 쓴다. 2.4GHz가 혼잡해지면 RTSP가 끊기고 녹화에 공백이 생긴다 —
**사람이 많을 때, 즉 사고가 날 그때 정확히 끊기는 구조다.** 평소엔 멀쩡히 돌아 눈치채기도 어렵다.

- [ ] **카메라 SD카드 녹화를 켠다.** TP-Link 공식 FAQ 기준 "Tapo Care · SD카드 녹화 ·
      NVR/ONVIF **셋 중 둘만** 동시에" 돌아간다. 즉 **클라우드 구독(Tapo Care)을 안 쓰면
      SD 녹화와 RTSP가 같이 된다.**

      이러면 Wi-Fi가 끊겨도, 맥이 죽어도, 디스크가 차도 카메라 안에는 남는다. 어드민에선 못 보고
      Tapo 앱으로 꺼내야 하지만, **분쟁 때 아무것도 없는 것과 앱으로 꺼내는 것은 완전히 다르다.**
      이걸 안 하면 단일 실패점이 Wi-Fi 하나다.
- [ ] 가능하면 게스트 Wi-Fi와 대역을 가른다(카메라 5GHz / 게스트 2.4GHz, 또는 그 반대).
- [ ] 실제로 끊기면 `mediamtx.yml`의 `source`를 `stream2`로 낮춘다 — 대역폭이 1/10이라 혼잡에
      훨씬 강하다. 화질은 그만큼 떨어진다(C-5의 트레이드오프).

정말 유선이 필요하면 TP-Link **VIGI**(PoE) 라인이다. 랜선을 3층까지 새로 뽑아야 하므로,
위를 먼저 하고 **실제로 끊기는지 본 다음** 판단한다.

## C-2. 카메라 계정 + RTSP 확인

Tapo 앱 → 해당 카메라 → 설정 → 고급 설정 → **카메라 계정**.
**Tapo 로그인 계정과 다른 별도 계정이다** — 이걸 만들지 않으면 RTSP 포트가 닫힌 채다.

- [ ] 계정 생성 → 적어둔다 `<카메라계정>` / `<카메라비번>`
- [ ] **카메라 설정에서 마이크(오디오)를 끈다.** 아래 참조 — 켜두면 위법이다.
- [ ] VLC로 먼저 확인한다. **여기서 안 되면 뒤는 전부 무의미하다.**

```
rtsp://<카메라계정>:<카메라비번>@<카메라IP>:554/stream1    # 고화질
rtsp://<카메라계정>:<카메라비번>@<카메라IP>:554/stream2    # 저화질
```

### 녹음은 위법이다 — 반드시 끈다

「개인정보 보호법」 제25조 제5항은 고정형 영상정보처리기기의 **녹음기능 사용을 금지**한다
(과태료 대상). 같은 조항이 임의 조작과 다른 곳 비추기도 금지한다.

문제는 **가만두면 위법이 자동으로 된다**는 것이다. Tapo는 마이크가 내장돼 있고 RTSP에 오디오
트랙을 기본으로 실어 보내며, **MediaMTX에는 트랙을 버리는 설정이 없다.** 받은 걸 그대로 녹화한다.
즉 카메라에서 끄는 것 말고 막을 방법이 없다.

- [ ] Tapo 앱 → 해당 카메라 → 설정에서 **마이크/오디오 끄기**
- [ ] VLC에서 `도구 → 코덱 정보`로 **오디오 트랙이 없는 것을 눈으로 확인.**
      트랙이 보이면 **여기서 멈춘다.** 설치를 진행하면 위법 녹음이 쌓인다.
- [ ] 팬틸트(회전) 모델이면 회전을 쓰지 않는다 — "임의 조작·다른 곳 비추기" 금지에 걸린다.
      아예 고정형 모델을 고르는 게 깔끔하다.

설정으로 못 막으니 **감시가 유일한 방어**다. 에이전트가 MediaMTX API의 트랙 목록을 30초마다
읽어 오디오가 섞이면 어드민 카드에 `⚠ 오디오 트랙 감지`를 띄우고 `agent.log`에도 남긴다.
펌웨어 업데이트나 앱 재설정으로 마이크가 조용히 되살아나는 경우를 잡기 위한 것이다 —
**경고가 뜨면 마이크를 다시 끄고, 그동안 쌓인 녹화는 파기한다.**

## C-3. 카메라 IP 고정

MediaMTX가 이 IP로 붙는다. DHCP로 바뀌면 **영상이 조용히 먹통**이 된다 —
조명 B-2와 같은 함정이고, 실제로 같은 이유로 터진다.

- [ ] 공유기에서 **카메라 2대 모두** MAC에 **DHCP 예약**
- [ ] IP를 적어둔다 → `<카메라IP>`(출입구) · `<카메라IP2>`(라운지)

---

## C-4. MediaMTX

```bash
brew install mediamtx
```

설정 파일을 템플릿에서 만든다. `<>`로 감싼 값을 전부 채운다 — **하나라도 남기면 인증이
비어 누구나 볼 수 있게 된다.**

```bash
cd 06-applications/control-agent
cp mediamtx/mediamtx.yml "$(brew --prefix)/etc/mediamtx/mediamtx.yml"   # ← 디렉터리 안이다. brew 가 만든다
# 편집: <스트림계정> <스트림비번> <녹화경로> <카메라계정> <카메라비번> <카메라IP>
```

`<스트림계정>`/`<스트림비번>`은 여기서 새로 정하는 값이다(카메라 계정과 다르다).
어드민이 영상을 볼 때 쓸 계정이고, C-7에서 Supabase에도 같은 값을 넣는다.

- [ ] **비밀번호는 32자 이상 랜덤으로 만든다.** `cam.nmwc.ai.kr`은 전 인터넷에 열리는데
      MediaMTX에는 브루트포스 방어가 없다. 사람이 외울 값이 아니니 짧게 만들 이유도 없다:

      ```bash
      LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40; echo
      ```

- [ ] `<녹화경로>`는 **iCloud 동기 폴더가 아닌 곳**으로 한다. `~/typelounge-recordings` 등.
      데스크탑·문서 아래에 두면 동기화가 세그먼트를 계속 업로드하며 디스크와 업링크를 태운다.

```bash
brew services start mediamtx
```

- [ ] 로그에 카메라 path가 `ready`로 뜬다
- [ ] 맥에서 아래가 `200`으로 답한다 ← **여기까지가 로컬 확인이다**

      ```bash
      curl -s -o /dev/null -w '%{http_code}\n' -u '<스트림계정>:<스트림비번>' \
        http://127.0.0.1:8888/entrance/index.m3u8
      curl -s -o /dev/null -w '%{http_code}\n' -u '<스트림계정>:<스트림비번>' \
        http://127.0.0.1:8888/lounge/index.m3u8
      curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/entrance/index.m3u8   # 401 이어야 정상
      ```

> **자격증명은 `Authorization` 헤더로만 전달된다.** `?user=&pass=` 같은 쿼리스트링은 MediaMTX
> v1.18.0에서 "long standing security flaw"로 규정돼 막혔고, `authMethod: internal`은 애초에
> 토큰을 보지 않고 user/pass만 비교한다. 브라우저에서 주소창에 URL을 붙여넣어 확인하려 하면
> 401만 보게 되니, 확인은 위 `curl -u`로 한다(브라우저는 Basic 인증 대화상자를 띄운다).

---

## C-4b. 카메라 없이 전 구간 검증 (권장 — 카메라 사기 전에)

**카메라가 없어도 가짜 스트림으로 admin까지 전부 확인할 수 있다.** 이걸 먼저 하면 설치 당일에
남는 미지수가 "카메라가 RTSP를 뱉는가" 하나로 줄어든다. 특히 **hls.js와 MediaMTX 인증이
실제로 맞물리는지**는 이 방법 말고는 카메라를 산 뒤에야 알 수 있다.

임시로 로컬 RTSP 수신만 연다. **`127.0.0.1`에 묶어서 LAN에도 안 열린다.**

```yaml
# mediamtx.yml — 검증 동안만. 끝나면 되돌린다.
rtsp: yes
rtspAddress: 127.0.0.1:8554
```

```yaml
# paths 에 임시 경로 추가 (entrance 는 카메라가 없으니 아직 안 뜬다)
  testpattern:
    source: publisher
```

```bash
brew services restart mediamtx
brew install ffmpeg    # 없으면

# 컬러바를 15fps로 밀어넣는다. lavfi testsrc 는 비디오만이라 오디오가 안 붙는다.
ffmpeg -re -f lavfi -i "testsrc=size=1280x720:rate=15" \
  -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
  -f rtsp rtsp://127.0.0.1:8554/testpattern
```

어드민 → CCTV → `+ 카메라 추가` → 이름 `테스트`, 스트림 이름 `testpattern`.

- [ ] **컬러바가 admin 화면에 뜬다** ← 여기까지 오면 admin→터널→MediaMTX→hls.js 인증이 전부 맞물린 것이다
- [ ] 카드에 `녹화 중 · 연결됨` 이 뜬다 (녹화도 같이 검증된다)
- [ ] 10분쯤 두었다가 **되감기**로 그 구간이 재생된다

**오디오 경고도 같이 검증한다.** ffmpeg를 끊고 오디오를 섞어 다시 밀어넣는다:

```bash
ffmpeg -re -f lavfi -i "testsrc=size=1280x720:rate=15" -f lavfi -i "sine=frequency=440" \
  -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -c:a aac -shortest \
  -f rtsp rtsp://127.0.0.1:8554/testpattern
```

- [ ] 30초 안에 카드 맨 앞에 **`⚠ 오디오 트랙 감지`** 가 뜬다
- [ ] `agent.log` 에도 같은 경고가 남는다

정리 — **되돌리는 걸 잊으면 로컬 RTSP가 계속 열려 있고 가짜 카메라가 어드민에 남는다:**

- [ ] ffmpeg 종료
- [ ] 어드민에서 `테스트` 카메라 **등록 해제**
- [ ] `mediamtx.yml` 에서 `rtsp: no` 로 되돌리고 `testpattern` 경로 삭제
- [ ] `brew services restart mediamtx`
- [ ] 녹화 폴더의 `testpattern/` 삭제 (보관기간까지 디스크를 차지한다)

## C-5. 용량 계산

MediaMTX는 받은 영상을 다시 인코딩하지 않는다 — 카메라 비트레이트가 그대로 디스크 소모다.

| 소스 | 하루/대 | **2대** 7일 | **2대** 30일 |
|---|---|---|---|
| `stream1` 고화질 | 20~40GB | 280~560GB | 1.2~2.4TB |
| `stream2` 저화질 | 3~5GB | 42~70GB | 180~300GB |

**카메라가 2대라 소모도 2배다.** 고화질 2대·7일이면 최대 560GB로, 맥 내장 디스크에는 빠듯할 수
있다. 모자라면 **라운지 쪽만 `stream2`로 낮춘다** — 분쟁에서 실제로 다시 보게 되는 건 대개
출입구(누가 언제 드나들었나)이고, 라운지는 '무슨 일이 있었나'를 보는 용도라 화질 요구가 낮다.

- [ ] `df -h` 로 남은 용량을 확인하고 `recordDeleteAfter`를 정한다
- [ ] 정한 값을 C-0의 안내판·C-7의 시크릿과 맞춘다

> **디스크가 차면 녹화만 조용히 멈춘다** — 실시간 화면은 멀쩡히 나온다. 그래서 어드민이
> 남은 용량과 최근 세그먼트 갱신 시각을 계속 띄운다. 그 숫자를 가끔 본다.

## C-6. 터널

> **선행 조건: 도메인이 Cloudflare DNS에 올라가 있어야 한다.** 없으면 이 단계를 건너뛰고
> Tailscale로 갈 수 있다 — 단 그 경우 **admin을 보는 기기마다 Tailscale이 필요**해서
> 직원·외부인 폰에서는 영상이 안 보인다. 혼자 본다면 그쪽이 더 간단하다.

**NMWC 계정 실측(2026-08-03) — 이 조건은 이미 충족돼 있다:**

| | |
|---|---|
| 도메인 | `nmwc.ai.kr` (Cloudflare Free, Active). 계정에 이 하나뿐이다 |
| DNS | 12/200 사용. `cam`·`camrec` 이름 충돌 없음 |
| 선례 | 터널 `nmwc-mattermost`가 이미 `mm`·`sb`·`ws`를 서빙 중 — 같은 CLI 방식이다 |

두 가지를 알고 시작한다:

- **Zero Trust 플랜을 고를 필요가 없다.** 대시보드의 Networks → Tunnels는 온보딩(플랜 선택)을
  요구하지만, 아래 CLI로 만드는 건 *locally-managed tunnel*이라 그 경로를 안 탄다.
  기존 `nmwc-mattermost`도 같은 방식이다. 플랜 선택 화면이 뜨면 그냥 나온다.
- **서브도메인은 한 단계까지만 쓴다.** Free 플랜의 Universal SSL은 `nmwc.ai.kr`과
  `*.nmwc.ai.kr`만 커버한다(실측). `cam.typelounge.nmwc.ai.kr`처럼 두 단계로 가면
  인증서가 없어 TLS부터 실패하고, 고치려면 ACM(유료)이 필요하다.

> ⚠️ **와일드카드 레코드가 이미 있다** — `*.nmwc.ai.kr CNAME nmwc.ai.kr (DNS only)`.
> 우리가 만들 `cam`·`camrec`은 더 구체적이라 우선하므로 충돌은 없다. 다만 **터널이 안 붙었거나
> 이름을 오타 냈을 때 연결 거부가 아니라 Vercel 페이지(404)가 돌아온다.** "401이 나와야 정상"인
> 확인 단계에서 엉뚱한 응답을 보게 되니, 그럴 땐 DNS부터 의심한다.

```bash
brew install cloudflared
cloudflared tunnel login          # 브라우저가 열리면 nmwc.ai.kr 를 고른다
cloudflared tunnel create typelounge-cam        # 출력된 <터널ID>를 적어둔다
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <터널ID>
credentials-file: /Users/<사용자>/.cloudflared/<터널ID>.json
ingress:
  - hostname: cam.nmwc.ai.kr
    service: http://127.0.0.1:8888      # 실시간(HLS)
  - hostname: camrec.nmwc.ai.kr
    service: http://127.0.0.1:9996      # 녹화 재생
  - service: http_status:404
```

호스트네임을 둘로 나눈 이유: cloudflared는 경로 접두사를 떼어주지 못해서, 한 호스트에
두 포트를 경로로 나눠 붙일 수 없다. 호스트 두 개가 가장 싸다.

```bash
cloudflared tunnel route dns typelounge-cam cam.nmwc.ai.kr
cloudflared tunnel route dns typelounge-cam camrec.nmwc.ai.kr
sudo cloudflared service install                 # 재부팅해도 살아나게
```

**외부 망(LTE 테더링 등)에서** 확인한다 — 집·현장 Wi-Fi에서는 로컬로 붙어 터널을 안 탄다.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -u '<스트림계정>:<스트림비번>' \
  https://cam.nmwc.ai.kr/entrance/index.m3u8            # 200
curl -s -o /dev/null -w '%{http_code}\n' -u '<스트림계정>:<스트림비번>' \
  https://cam.nmwc.ai.kr/lounge/index.m3u8              # 200
curl -s -o /dev/null -w '%{http_code}\n' https://cam.nmwc.ai.kr/entrance/index.m3u8   # 401
curl -s -o /dev/null -w '%{http_code}\n' -u '<스트림계정>:<스트림비번>' \
  'https://camrec.nmwc.ai.kr/list?path=entrance'        # 200
```

- [ ] 인증을 붙이면 `200`
- [ ] **자격증명 없이는 `401`** ← 이게 안 막히면 공개된 것이다. 여기서 멈춘다.
- [ ] `camrec` 쪽도 같은 결과가 나온다

---

## C-7. 서버 설정

```bash
cd <이 레포>
supabase db push
supabase functions deploy control
supabase secrets set \
  CAMERA_LIVE_BASE=https://cam.nmwc.ai.kr \
  CAMERA_PLAYBACK_BASE=https://camrec.nmwc.ai.kr \
  CAMERA_STREAM_USER=<스트림계정> \
  CAMERA_STREAM_PASS=<스트림비번> \
  CAMERA_RETENTION_DAYS=7
```

**넷 중 하나라도 비면 미설정으로 본다** — 반쪽 설정으로 화면을 열면 '재생이 안 되는데 왜인지
모르는' 상태가 되고, 그건 카메라 고장과 구분되지 않는다.

`CAMERA_RETENTION_DAYS`는 `mediamtx.yml`의 `recordDeleteAfter`와 **같은 숫자**여야 한다.
어긋나면 어드민이 실제보다 긴 보관기간을 말하고, 안내판으로 손님에게 그렇게 약속한 것이 된다.

## C-8. 에이전트

에이전트는 영상을 나르지 않는다. **'녹화가 진짜 돌고 있나'만 관찰해 어드민에 알린다.**

`06-applications/control-agent/.env`에 추가:

| 키 | 값 |
|---|---|
| `MEDIAMTX_API_URL` | `http://127.0.0.1:9997` |
| `MEDIAMTX_RECORD_DIR` | C-4의 `<녹화경로>` (`%path` 앞부분까지) |

```bash
launchctl kickstart -k gui/$(id -u)/kr.nmwc.typelounge.control-agent
tail -f agent.log
```

- [ ] `[camera] 카메라 N대 관찰 시작`
- [ ] `MEDIAMTX_RECORD_DIR 미설정` 이 뜨면 `.env`가 안 읽힌 것이다

## C-9. 어드민 등록

`admin.html` → **CCTV** → `+ 카메라 추가` → 이름 + **스트림 이름**.

스트림 이름은 `mediamtx.yml`의 `paths` 키와 **글자까지 같아야 한다** — `entrance`(출입구),
`lounge`(라운지) 두 개를 각각 등록한다.
Tasmota Topic 등록과 같은 계약이라 같은 함정을 갖는다 — 다르면 카드는 뜨는데 영상만 안 나온다.

- [ ] 카드가 **2개** 뜨고 **둘 다** 영상이 재생된다
- [ ] 상태에 `녹화 중 · 연결됨 · N초 전 · 남은 용량` 이 보인다
- [ ] 되감기에서 10분 전 구간이 재생된다 (두 대 각각)

---

## 막혔을 때

| 증상 | 확인 |
|---|---|
| VLC에서도 RTSP가 안 열린다 | C-2 카메라 계정을 안 만들었다. 배터리 모델이면 RTSP 자체가 없다 |
| 평소엔 되는데 사람 많으면 끊긴다 | 2.4GHz 혼잡(C-1). SD 녹화를 켜뒀으면 **그 구간은 카메라 안에 남아 있다** — Tapo 앱에서 꺼낸다. 반복되면 `stream2`로 낮춘다 |
| SD 녹화를 켰더니 RTSP가 죽었다 | Tapo Care(클라우드 구독)까지 셋이 켜져 있다. 셋 중 둘만 된다 — 구독을 끈다 |
| MediaMTX 로그에 `ready`가 안 뜬다 | 카메라 IP·계정. 공유기가 기기 간 통신을 막는(AP isolation) 설정인지도 본다 |
| 로컬은 되는데 외부에서 안 된다 | 터널. `cloudflared` 로그와 DNS 라우팅(C-6) |
| 자격증명 없이도 보인다 | **즉시 멈춘다.** `mediamtx.yml`의 `<스트림계정>` 자리가 안 채워졌다 |
| 카드는 뜨는데 영상만 안 나온다 | 스트림 이름 오타(C-9). `paths` 키와 대조 |
| 크롬은 되는데 **iPhone 사파리만** 안 된다 | **CDN 차단이 아니다**(2026-08-10에 그렇게 오진했다). 아래 "iPhone만 400으로 죽는 이유"를 읽는다. `?debug=1`을 붙여 열면 카드에 `http=400`이 보인다 — 그러면 Cloudflare Transform Rule이 빠졌거나 꺼진 것이다 |
| **세 대 다 화면이 안 나온다** (카드는 `연결됨`) | 오디오를 떼는 **ffmpeg 재발행이 죽은 것**이다. 아래 "카메라 오디오를 떼는 재발행"을 본다. `curl -s localhost:9997/v3/paths/list`에서 `ready: false`면 확정이다 |
| `녹화 안 됨` 인데 화면은 나온다 | **정상적인 경고다.** 디스크가 찼거나 `<녹화경로>` 권한. `df -h` |
| `아직 보고를 받은 적 없음` | 에이전트가 CCTV 설정을 못 읽었다(C-8) |
| 되감기 목록만 안 나온다 | `/list` 응답만 실패한 것. 재생은 별개 요청이라 시각을 직접 골라 틀면 된다 |
| 되감기가 한참 뒤에야 재생된다 | **정상이다.** 통째로 받은 뒤 재생이 시작된다(위 "아직 검증 안 된 것" 2번). 길이를 줄인다 |
| 어드민에 `⚠ 오디오 트랙 감지` | **위법 녹음 중이다.** 카메라 마이크를 끄고(C-2), 그동안 쌓인 녹화를 파기한다 |
| **손님 유무와 상관없이 자꾸 끊긴다** | 아래 "터널이 태평양을 두 번 건너는 문제"를 먼저 읽는다. 2.4GHz 혼잡(윗줄)과 증상이 같지만 **사람 없을 때도 끊기면** 이쪽이다 |
| 한 번 끊기면 새로고침 전까지 검은 화면 | **2026-08-10에 고쳤다.** 아래 "어드민이 끊김에서 돌아오는 방식" 참조 |
| 카드에 `연결 실패 — 15초마다 다시 시도해요` | 빠른 백오프 6회를 다 썼다는 뜻이다. **포기가 아니라 느린 재시도로 내려간 것**이라, 네트워크가 돌아오면 15초 안에 저절로 붙는다. 안 붙으면 터널·MediaMTX부터 본다 |

### 어드민이 끊김에서 돌아오는 방식 (2026-08-10)

그전에는 hls.js가 fatal을 던지면 오류 문구만 칠하고 끝냈다. `CAM.attached`가 true로 남아
목록 갱신이 다시 붙이지 않으니 **순간 끊김 하나가 새로고침 전까지 검은 화면으로 굳었다** —
"자꾸 끊긴다"의 정체는 끊김이 잦은 게 아니라 한 번 끊기면 안 돌아온 것이었다.

지금은 오류 종류별로 갈라 되살린다. 싼 수단부터다:

| 오류 | 처리 | 왜 |
|---|---|---|
| 매니페스트 단계(`manifestLoad*`) | 인스턴스를 새로 만든다 | hls.js에서 `MANIFEST_LOADING`을 트리거하는 건 `loadSource` 하나뿐이라 `startLoad`는 **이 부류에 no-op**이다. 하필 터널이 내려갔을 때 제일 먼저 나오는 오류다 |
| 그 밖의 네트워크 | 같은 인스턴스로 `startLoad()` | 연결만 끊긴 것이라 재부착보다 훨씬 싸다 |
| 미디어 | `recoverMediaError()` | 디코더만 어긋난 것이라 인스턴스를 안 버려도 된다 |
| 나머지 | 재부착 | |

셋 다 **같은 회계**를 탄다 — 1s → 2s → … → 30s 백오프로 6회. 다 쓰면 인스턴스를 정리하고
부착 표시를 지워 **15초 목록 갱신이 느린 재시도 역할**을 하게 한다(그래서 카드 문구가
`연결 실패 — 15초마다 다시 시도해요`다). 네트워크가 돌아오면 저절로 붙는다.

백오프는 **재생이 30초 이어져야** 처음으로 되돌아간다. 조각 하나 들어왔다고 되돌리면
끊김 사이에 조각이 하나씩만 들어오는 플래핑에서 백오프가 1초에 고정돼, 이미 버거운
업링크를 1초마다 두드리게 된다 — 왕복 0.9초에 1초 세그먼트 3대인 여기서는 플래핑이
예외가 아니라 기본값이다.

> 이 판단들은 `06-applications/admin-retry.test.js`가 검증하고 CI에서 돈다.
> **실기기로는 아직 확인 못 했다** — 현장 맥에서 터널을 의도적으로 내렸다 올려
> (a) 매니페스트 실패가 61초 헛돌지 않는지 (b) 플래핑에서 지연이 실제로 늘어나는지
> 눈으로 봐야 끝난다.

### 카메라 오디오를 떼는 재발행 — **이게 죽으면 영상이 통째로 없다** (2026-08-10)

카메라 3대 모두 **마이크가 꺼지지 않는다**(설정을 껐는데도 `pcm_alaw` 트랙이 나온다).
MediaMTX는 받은 트랙을 그대로 넘기고 녹화하므로, 카메라 RTSP를 직접 소스로 걸면
그 순간 위법 녹음이 된다(C-2). 그래서 구조가 이렇다:

```
카메라 RTSP (영상+오디오)  →  로컬 ffmpeg (-an 으로 오디오 폐기)  →  MediaMTX (127.0.0.1:8554)
```

`mediamtx.yml`의 `paths`가 전부 `source: publisher`이고 `rtspAddress`가 `127.0.0.1`로 묶인
이유가 이것이다. **카메라가 MediaMTX에 직접 붙지 않는다** — 중간의 ffmpeg가 유일한 경로다.

> #### 이 재발행이 40시간 공백을 만들었다
>
> 2026-08-09 19:29~20:05에 셋 다 `Broken pipe`로 죽었고, 8/10 오전까지 아무도 살리지 않았다.
> **그 구간은 실시간도 서버 녹화도 없다.** 손으로 띄운 프로세스라 관리 주체가 없었고,
> 절차가 레포에도 문서에도 없어서 "왜 안 나오지"를 터널과 어드민 코드에서 찾았다.
>
> 카드가 `연결됨`으로 보이는 것에 속으면 안 된다 — 그건 에이전트가 살아 있다는 뜻이지
> 영상이 흐른다는 뜻이 아니다. **`paths/list`의 `ready`가 유일한 판정 기준이다.**

띄우는 법. 스크립트는 `control-agent/camera-republish.sh`에 있고 자격증명은 같은 폴더 `.env`의
`CAM_RTSP_USER`/`CAM_RTSP_PASS`에서 읽는다:

```bash
cd ~/Dev/space-brand-system/06-applications/control-agent
nohup ./camera-republish.sh office       192.168.200.148 >> ~/Library/Logs/typelounge/camera-office.log 2>&1 &
nohup ./camera-republish.sh lounge_left  192.168.200.193 >> ~/Library/Logs/typelounge/camera-lounge_left.log 2>&1 &
nohup ./camera-republish.sh lounge_right 192.168.200.134 >> ~/Library/Logs/typelounge/camera-lounge_right.log 2>&1 &

# 판정 — 셋 다 ready 이고 tracks 가 ['H264'] 여야 한다. 오디오가 섞이면 즉시 멈춘다.
curl -s http://127.0.0.1:9997/v3/paths/list | python3 -c "import json,sys
for p in json.load(sys.stdin).get('items',[]): print(' ', p['name'], p['ready'], p.get('tracks'))"
```

> ⚠️ **아직 자동 복구가 없다. 맥을 재부팅하면 위 명령을 다시 쳐야 한다.**
>
> **MediaMTX를 재시작할 때도 같이 죽는다.** 2026-08-10에 세 번 겪었다 — `brew services
> restart mediamtx` 뒤에는 항상 위 명령을 다시 친다.

#### 왜 launchd에 못 올리는가 (2026-08-10, 시도하고 실패한 기록)

**macOS 26이 launchd에서 뜬 Homebrew ffmpeg의 로컬 네트워크 접근을 막는다.** launchd로
돌리면 카메라 IP에 `No route to host`가 나고, **같은 스크립트를 터미널에서 돌리면 된다** —
터미널이 가진 로컬 네트워크 권한을 자식이 물려받기 때문이다. 예전 설정이 손으로 띄운
프로세스였던 것도 그래서 우연히 작동했다.

launchd 전체가 막힌 게 아니다. Apple 서명 도구인 `nc`는 launchd에서도 카메라 554 포트에
붙는다(실측). **ffmpeg 바이너리만** 막힌다.

| 시도 | 결과 |
|---|---|
| LaunchAgent에서 `camera-republish.sh` 직접 실행 | ❌ `No route to host` |
| 시스템 설정 > 로컬 네트워크에서 허용 | ❌ **목록에 ffmpeg 항목 자체가 없다.** 토글할 대상이 없다 |
| `.app` 번들(ad-hoc 서명)로 감싸 LaunchAgent에서 실행 | ❌ 같은 오류 |
| 같은 `.app`을 `open`으로 실행 | ❌ 같은 오류. **권한 프롬프트도 안 뜬다** |

`.app`이 안 통한 이유는 실행 파일이 셸 스크립트여서로 보인다 — `ps`에 `/bin/bash ...`로
잡히고, TCC가 번들이 아니라 인터프리터를 주체로 본다.

| LaunchAgent가 `osascript`로 Terminal에 시키기 | ❌ **자동화 권한**이라는 또 다른 벽. launchd에선 그 프롬프트가 못 뜬다 |

> 참고로 시스템 설정의 로컬 네트워크 목록에는 **mosquitto가 있고 켜져 있다.** 같은 Homebrew
> 바이너리에 같은 launchd인데 등록돼 있다 — 즉 launchd라서 불가능한 게 아니라, ffmpeg가
> 권한을 물어볼 기회를 못 얻은 것이다. 등록만 되면 토글로 풀린다.

#### 지금 쓰는 방법 — 로그인 항목 + 터미널 (사람이 한 번 설정한다)

권한 프롬프트를 띄울 수 있는 건 GUI 세션의 앱뿐이라, **Terminal에 맡기는 게 확실하다.**
Terminal은 이미 로컬 네트워크 권한이 있어 자식 ffmpeg가 그대로 물려받는다.

1. **터미널 › 설정 › 프로파일**에서 프로파일 하나를 복제하고(예: `TypeLounge Relay`),
   *셸* 탭의 **시작 시 명령 실행**에 아래를 넣는다:

   ```
   /Users/hyungwoon/Dev/space-brand-system/06-applications/control-agent/camera-relay-all.sh
   ```

2. **시스템 설정 › 일반 › 로그인 항목**에 **터미널**을 추가한다.
3. 터미널 › 설정 › 일반에서 **새로운 윈도우가 열릴 때** 그 프로파일을 쓰게 한다.

로그인할 때마다 터미널 창이 하나 뜬다. 무인 운영 맥이라 감수할 만하고, 오히려 **재발행이
살아 있는지 눈으로 확인되는 창**이라 이점도 있다.

> 아직 안 해본 다른 경로: 실행 파일을 셸 스크립트가 아닌 **진짜 바이너리**(Swift/Go)로 만들어
> `.app`에 넣으면 TCC가 번들을 주체로 인식할 수 있다. 그때는 launchd로 깔끔하게 올라간다.

### iPhone만 400으로 죽는 이유 — UA를 덮어써서 푼다 (2026-08-10)

PC 크롬 ✅ · **맥 사파리 ✅** · iPhone 사파리 ❌. 맥 사파리가 멀쩡한 게 결정적이었다 —
WebKit 문제도, 리다이렉트 문제도 아니라는 뜻이다.

원인은 MediaMTX가 **iOS User-Agent에만** 쿠키를 요구하는 것이다:

```go
// internal/servers/hls/http_server.go
if _, err := ctx.Request.Cookie("cookieCheck"); err != nil && isIOS(ctx.Request.UserAgent()) {
    s.writeErrorNoLog(ctx, http.StatusBadRequest,
        fmt.Errorf("HLS on iOS requires the server to set and read cookies"))
```

같은 요청을 **UA만 바꿔서** 보내면 갈린다(터널 경유 실측):

```
iPhone UA  → 400  {"error":"HLS on iOS requires the server to set and read cookies"}
그 밖의 UA → 200
```

그런데 브라우저가 그 쿠키를 보낼 방법이 없다. hls.js의 XHR은 `withCredentials=false`가 기본이라
교차 사이트 쿠키를 주고받지 않고, 켜려 해도 **MediaMTX는 `Access-Control-Allow-Credentials`를
어떤 경로에서도 보내지 않는다**(소스 확인). 어드민(`typelounge.vercel.app`)과 스트림
(`cam.nmwc.ai.kr`)이 다른 사이트인 한 **클라이언트 코드로는 못 푼다.**

그래서 **Cloudflare Transform Rule에서 UA를 덮어쓴다.** 검사 자체가 성립하지 않게 만드는 것이다.

| 항목 | 값 |
|---|---|
| 위치 | Cloudflare 대시보드 → `nmwc.ai.kr` → Rules → **Create rule** → *Request Header Transform Rule* |
| 이름 | `cam: strip iOS UA` |
| 조건 | *Custom filter expression* → `Hostname` **equals** `cam.nmwc.ai.kr` |
| 동작 | **Set static** — Header name `User-Agent`, Value `TypeLounge-Viewer/1.0` |

Free 플랜에 포함되고 Workers가 아니라 **요청 한도가 없다.** 세그먼트 요청이 초당 여러 건이라
Workers 무료 한도(10만/일)로는 아슬아슬한데, Transform Rule에는 그 제약이 없다.

적용 뒤 **iPhone 없이 검증된다** — UA를 흉내내 400이 200으로 바뀌는지 보면 된다:

```bash
IOS="Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
curl -s -o /dev/null -w '%{http_code}\n' -A "$IOS" -H "Authorization: Basic <...>" \
  https://cam.nmwc.ai.kr/office/index.m3u8?cookieCheck=1
# 적용 전 400 → 적용 후 200 이어야 한다
```

**2026-08-10 적용 완료.** 규칙을 넣은 직후 같은 명령으로 확인했다:

| | 적용 전 | 적용 후 |
|---|---|---|
| iPhone UA · `index.m3u8?cookieCheck=1` | 400 | **200** |
| iPhone UA · 리다이렉트까지 따라가기 | — | **200** (리다이렉트 1회) |
| 카메라 3대 · 마스터 → 하위 → 세그먼트 | — | **전부 200** (180~280KB, 0.24~0.41s) |
| iPhone UA · **인증 없이** | 401 | **401** (보안 회귀 없음) |

> 이 규칙이 꺼지거나 지워지면 **iPhone에서만** 영상이 400으로 죽는다. PC는 멀쩡해서
> 눈치채기 어렵다 — iPhone 제보가 오면 여기부터 본다.

> **어드민에 `?cookieCheck=1`을 붙이는 우회는 하지 마라.** 그날 한 번 넣었다가 걷어냈다 —
> 302를 건너뛰게 만들어 **Set-Cookie를 받을 기회마저 없애서** 오히려 나빠진다.
> `admin.html`의 `attachLive` 주석에 그 오진 기록을 남겨뒀다.

### 터널이 태평양을 두 번 건너는 문제 (2026-08-10 실측)

**`cam.nmwc.ai.kr` 요청이 Cloudflare LAX(로스앤젤레스) 엣지로 들어간다.** 서울 KT 회선에서
5회 연속 측정해 전부 `cf-ray: ...-LAX`였다. 즉 영상 경로가
**합정 맥(서울) → LA → 보는 사람(서울)** 로, 세그먼트 하나마다 태평양을 왕복한다.
실측 왕복 **0.73~0.94초**다(같은 회선에서 naver.com은 0.27초). 기존 `mm.nmwc.ai.kr`도 1.4초로 같은 경로다.

Cloudflare **Free 플랜**은 한국 ISP 피어링 비용 때문에 국내 트래픽을 해외 엣지로 보낸다.
도메인이나 터널 설정 문제가 아니라 **플랜의 성질**이라, 설정을 고쳐서는 안 된다.

여기에 요청 수를 부풀리는 요인 세 가지가 겹친다 — 세그먼트 하나를 받는 데 왕복이 3번 든다:

| 요인 | 내용 | 고칠 수 있나 |
|---|---|---|
| 프리플라이트 미캐싱 | MediaMTX가 `Access-Control-Max-Age`를 안 보낸다 → 매 요청 앞에 OPTIONS가 붙는다 | 서버 설정 필요 |
| `cookieCheck` 302 | v1.18의 세션 쿠키. **교차 출처 XHR은 쿠키를 못 보관**해 매번 302를 다시 받는다 | ~~MediaMTX에 끄는 옵션이 없다~~ → **2026-08-10 우회함.** 어드민이 `?cookieCheck=1`을 처음부터 붙여 302 자체를 안 만든다 |
| 1초 세그먼트 × 3대 | `hlsSegmentDuration: 1s`에 카메라 3대가 동시 재생된다 | **2026-08-10에 4초로 올렸다** |

쥘 수 있는 수단을 싼 순서대로:

1. **현장 맥의 `mediamtx.yml`에서 `hlsSegmentDuration`을 `4s`로 올린다.** 요청 수가 1/4가 된다.
   `hlsSegmentCount: 7`은 그대로 두면 라이브 윈도우가 28초로 늘어 지터에도 강해진다.
   대가는 지연이 몇 초 느는 것뿐이다 — 감시 용도에는 문제가 안 된다.
2. **동시에 보는 카메라 수를 줄인다.** 3대를 동시에 틀면 부하도 3배다.
3. **Tailscale로 갈아탄다**(C-6의 대안). 동일 망이면 LAN 직통이라 태평양 왕복이 사라진다.
   대가는 보는 기기마다 Tailscale이 필요해서 외부인 폰에선 안 보인다는 것이다.
4. Cloudflare 유료 플랜(Argo Smart Routing 등)은 돈으로 물러나는 경로다. 먼저 1번을 해본다.

## 서버 녹화를 끈 뒤 남은 것 (2026-08-10)

현장 지시로 **서버 녹화와 되감기를 껐다**(`record: no` · `playback: no`). 영상은 카메라
SD카드에 남으므로 보관 약속 자체는 유지된다. 다만 두 가지가 따라온다.

**1. `recordDeleteAfter`가 더 이상 안 돈다.** 파기를 집행하던 유일한 주체였는데(C-0의 3번),
녹화를 끄면 그것도 같이 멈춘다. **8/8~8/9에 쌓인 16GB가 영구히 남는다** —
`office` 4.4G · `lounge_left` 6.0G · `lounge_right` 5.5G, 각 31개 세그먼트.

보관기간 7일 기준으로 **2026-08-16 이후에 사람이 지운다.** 그 전에 지우면 아직 유효한
기록을 없애는 것이고, 안 지우면 "7일 뒤 파기"라는 약속과 어긋난 채로 남는다.

```bash
# 2026-08-16 이후에 실행한다. 그 전에는 실행하지 않는다.
rm -rf ~/typelounge-recordings/office ~/typelounge-recordings/lounge_left ~/typelounge-recordings/lounge_right
```

**2. 보관기간 4곳의 의미가 바뀌었다.** 이제 `recordDeleteAfter`가 아니라 **카메라 SD카드
용량**이 실제 보관기간을 정한다. C-0의 표에서 3번이 더 이상 집행 주체가 아니다 —
안내 문구를 유지하려면 SD 녹화가 실제로 며칠을 담는지 Tapo 앱에서 확인해야 한다.
**아직 확인 안 했다.**

또 예전 방식이 남긴 `~/typelounge-recordings/.ffmpeg_*.log` 3개(합 328MB)가 있다.
Broken pipe로 죽은 증거라 남겨뒀지만, 내용은 이 문서에 정리돼 있으니 지워도 된다.

---

## 알아둘 것

- **카메라 SD카드가 마지막 사본이다.** 맥·Wi-Fi·디스크 중 무엇이 죽어도 살아남는 유일한 경로다.
  어드민에는 안 뜨지만, 그건 "볼 수 없다"이지 "없다"가 아니다.
- **`녹화 안 됨`은 설정이 아니라 파일로 판정한다.** 설정 플래그는 디스크가 차도 켜진 채로
  남지만 파일 mtime은 거짓말을 하지 않는다. 최근 120초 안에 세그먼트가 커졌으면 녹화 중이다.
- **`아직 보고를 받은 적 없음`은 `녹화 안 됨`이 아니다.** 합치면 방금 등록한 카메라가 장애처럼
  보이고, 반대로 진짜 장애가 왔을 때 아무도 그 경고를 믿지 않게 된다.
- **등록 해제는 녹화 파일을 지우지 않는다.** 되돌릴 수 없는 삭제를 되돌릴 수 있는 조작에
  딸려 보내지 않는다. 파일은 보관기간이 알아서 정리한다.
- **스트림 계정은 read/playback만 갖는다.** publish를 주면 그 계정을 쥔 사람이 카메라 화면을
  가짜 영상으로 덮어쓸 수 있다.
- **자격증명 회수는 두 곳을 같이 바꾼다** — `mediamtx.yml`의 계정과 Supabase 시크릿.
  한쪽만 바꾸면 화면이 통째로 안 나온다.
- **인증을 MediaMTX 내장으로 둔 건 비용 때문이다.** 외부 인증 서버로 돌리면 HLS 세그먼트마다
  인증 요청이 가고 그건 초당 4~5회 — 카메라 한 대로 하루 35만 호출이라 무료 한도를 하루 만에
  넘긴다.

## 아직 검증 안 된 것

**실기기로는 확인하지 못했다.** 카메라가 없어 RTSP 왕복을 못 돌렸고, MediaMTX·터널도
설정만 작성했다. 이 절차를 밟으면서 처음 확인된다. 특히 두 가지를 눈으로 봐야 한다:

1. ~~**HLS 세그먼트 인증**~~ — **2026-08-10 검증 완료.** 실카메라 3대로 전 구간이 통과했다.
   플레이리스트 → 하위 플레이리스트 → 세그먼트(290KB)까지 터널 경유 200이고, 인증을 빼면 401이다.
   브라우저 컨텍스트에서도 같은 결과를 받았고 PC 어드민에서 영상 재생을 눈으로 확인했다.
   추가로 알게 된 것: **교차 출처라 쿠키가 하나도 안 실리는데도 통과한다** — MediaMTX는
   `session` 쿼리로 판정하고 쿠키를 요구하지 않는다. 이 사실이 사파리 302 문제의 해법 근거가 됐다.
2. **되감기 재생의 메모리** — `<video src>`에는 헤더를 못 붙여서 fetch로 받아 blob으로 문다.
   즉 **통째로 받은 뒤에 재생이 시작된다.** 30분(고화질 0.6~1.2GB)에서 끊어뒀지만, 실제로
   버거우면 길이를 줄이거나 `stream2`로 낮춘다. 상시로 긴 구간이 필요해지면 그때 합정 맥에
   쿼리→헤더 변환 프록시를 두고 `<video src>` 한 줄로 되돌리는 게 맞다.
