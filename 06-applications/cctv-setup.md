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
cp mediamtx/mediamtx.yml "$(brew --prefix)/etc/mediamtx.yml"
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
| 크롬은 되는데 사파리만 안 된다 | hls.js가 안 실린 것. CDN 차단 여부 |
| `녹화 안 됨` 인데 화면은 나온다 | **정상적인 경고다.** 디스크가 찼거나 `<녹화경로>` 권한. `df -h` |
| `아직 보고를 받은 적 없음` | 에이전트가 CCTV 설정을 못 읽었다(C-8) |
| 되감기 목록만 안 나온다 | `/list` 응답만 실패한 것. 재생은 별개 요청이라 시각을 직접 골라 틀면 된다 |
| 되감기가 한참 뒤에야 재생된다 | **정상이다.** 통째로 받은 뒤 재생이 시작된다(위 "아직 검증 안 된 것" 2번). 길이를 줄인다 |
| 어드민에 `⚠ 오디오 트랙 감지` | **위법 녹음 중이다.** 카메라 마이크를 끄고(C-2), 그동안 쌓인 녹화를 파기한다 |

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

1. **HLS 세그먼트 인증** — 재생목록은 되는데 세그먼트만 401인 경우.

   양쪽 다 소스로 확인은 했다. hls.js는 `xhrSetup`을 `open()` 전에 부르고 이어지는
   `openAndSendXhr`가 `if (!xhr.readyState)`로 감싸 있어, 우리가 먼저 열고 헤더를 붙이면
   그대로 나간다(기본 loader도 `XhrLoader`). MediaMTX 쪽은 HLS·playback 서버 모두
   `Access-Control-Allow-Headers: Authorization`을 세팅하고 OPTIONS 프리플라이트를 처리한다.
   남은 건 이 둘이 실제로 맞물리는지 — 카메라가 붙는 날 처음 확인된다.
2. **되감기 재생의 메모리** — `<video src>`에는 헤더를 못 붙여서 fetch로 받아 blob으로 문다.
   즉 **통째로 받은 뒤에 재생이 시작된다.** 30분(고화질 0.6~1.2GB)에서 끊어뒀지만, 실제로
   버거우면 길이를 줄이거나 `stream2`로 낮춘다. 상시로 긴 구간이 필요해지면 그때 합정 맥에
   쿼리→헤더 변환 프록시를 두고 `<video src>` 한 줄로 되돌리는 게 맞다.
