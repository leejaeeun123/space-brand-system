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

watch_one() {
  local name="${1%%:*}" ip="${1#*:}"
  while true; do
    "$HERE/camera-republish.sh" "$name" "$ip" >> "$LOGDIR/camera-$name.log" 2>&1
    echo "[$(date '+%F %T')] $name 재발행이 멈춰 5초 뒤 다시 시작한다" >> "$LOGDIR/relay.log"
    sleep 5
  done
}

# 두 번 띄우면 같은 path에 두 publisher가 붙어 서로를 밀어낸다. 먼저 정리한다.
pkill -f "camera-republish.sh" 2>/dev/null
pkill -f "rtsp://127.0.0.1:8554/" 2>/dev/null
sleep 2

echo "[$(date '+%F %T')] relay 시작 (카메라 ${#CAMERAS[@]}대)" >> "$LOGDIR/relay.log"
for cam in "${CAMERAS[@]}"; do
  watch_one "$cam" &
done
wait
