#!/bin/bash
# 카메라 3대 재발행을 한꺼번에 띄우고, 죽으면 되살린다.
#
# 왜 이 파일이 따로 있나 — macOS 26의 로컬 네트워크 권한(TCC) 때문이다.
# launchd가 ffmpeg를 직접 띄우면 카메라 IP에 `No route to host`가 난다. 권한 주체가
# 안 잡혀 시스템 설정의 '로컬 네트워크' 목록에 뜨지도 않아 토글로 풀 수도 없다.
# 반면 **터미널에서 돌리면 된다** — Terminal.app이 가진 권한을 자식이 물려받기 때문이다.
# 그래서 로그인 시 launchd가 osascript로 Terminal을 시켜 이 스크립트를 돌린다
# (`kr.nmwc.typelounge.camera-relay` 에이전트). 자세한 배경은 cctv-setup.md
# "왜 launchd에 못 올리는가"에 있다.
#
# ⚠️ MediaMTX를 재시작하면 재발행이 전부 끊긴다(Broken pipe). 이 루프가 5초 뒤 되살리므로
#    보통은 손댈 필요가 없다 — 다만 그동안 영상에 공백이 생긴다.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="$HOME/Library/Logs/typelounge"
mkdir -p "$LOGDIR"

# path 와 카메라 IP. IP는 공유기에서 DHCP 예약으로 고정돼 있다(C-3).
CAMERAS=(
  "office:192.168.200.148"
  "lounge_left:192.168.200.193"
  "lounge_right:192.168.200.134"
)

# 퇴실 독려 판정에 쓰는 카메라 — **라운지만 본다**(형운 결정, 2026-08-17).
# `office`는 현관 방향이라 '나가는 중'과 '남아 있음'이 섞여 판정의 뜻이 흐려진다.
# 여기서 뺀 카메라는 감시되지 않는다 — 늘리려면 이 줄에 path를 더한다.
MOTION_PATHS="lounge_left lounge_right"

watch_one() {
  local name="${1%%:*}" ip="${1#*:}"
  while true; do
    "$HERE/camera-republish.sh" "$name" "$ip" >> "$LOGDIR/camera-$name.log" 2>&1
    echo "[$(date '+%F %T')] $name 재발행이 멈춰 5초 뒤 다시 시작한다" >> "$LOGDIR/relay.log"
    sleep 5
  done
}

# 움직임 감시(퇴실 독려용). **여기서 띄우는 이유는 권한이다.**
# macOS 26이 로컬 네트워크 접근을 바이너리 단위로 통제해, launchd 직속인 control-agent의
# Node는 카메라 IP에 EHOSTUNREACH가 난다(2026-08-18 실측 — 터미널에서는 같은 코드가 200).
# 이 스크립트는 권한을 이미 통과한 `.app` 아래에서 도므로 자식도 그 권한을 물려받는다.
# 재발행과 한 지붕에 두는 것이 어색해 보이지만, 둘의 공통점이 정확히 그 권한 경계다.
watch_motion() {
  local args=()
  for cam in "${CAMERAS[@]}"; do
    for want in $MOTION_PATHS; do
      [ "${cam%%:*}" = "$want" ] && args+=("$cam")
    done
  done
  if [ ${#args[@]} -eq 0 ]; then
    echo "[$(date '+%F %T')] MOTION_PATHS가 CAMERAS와 하나도 안 맞는다 — 움직임 감시를 건너뛴다" >> "$LOGDIR/relay.log"
    return
  fi
  if [ ! -f "$HERE/.env" ]; then
    echo "[$(date '+%F %T')] .env가 없어 움직임 감시를 건너뛴다" >> "$LOGDIR/relay.log"
    return
  fi
  while true; do
    node --env-file="$HERE/.env" "$HERE/src/motion-watch.js" "${args[@]}" >> "$LOGDIR/motion.log" 2>&1
    echo "[$(date '+%F %T')] 움직임 감시가 멈춰 5초 뒤 다시 시작한다" >> "$LOGDIR/relay.log"
    sleep 5
  done
}

# 두 번 띄우면 같은 path에 두 publisher가 붙어 서로를 밀어낸다. 먼저 정리한다.
# 감시자도 같이 정리한다 — 두 프로세스가 같은 카메라를 구독하면 알림이 둘로 갈려
# 각자 절반씩만 보게 된다(구독은 큐를 나눠 갖는다).
pkill -f "camera-republish.sh" 2>/dev/null
pkill -f "rtsp://127.0.0.1:8554/" 2>/dev/null
pkill -f "motion-watch.js" 2>/dev/null
sleep 2

echo "[$(date '+%F %T')] relay 시작 (카메라 ${#CAMERAS[@]}대)" >> "$LOGDIR/relay.log"
for cam in "${CAMERAS[@]}"; do
  watch_one "$cam" &
done

# 감시가 죽어도 영상은 계속 흘러야 한다 — 별도 백그라운드로 띄우고 `wait`는 전부를 기다린다.
watch_motion &

wait
