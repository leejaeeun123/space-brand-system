#!/bin/bash
# 카메라 재발행을 로그인 시 자동으로 뜨고 죽으면 되살아나게 설치한다.
#
# 이걸 안 하면: 맥을 재부팅하거나 MediaMTX를 재시작할 때마다 영상이 끊긴 채로 남는다.
# 2026-08-09에 재발행 3개가 죽은 뒤 아무도 살리지 않아 약 40시간 영상이 없었다.
#
# 왜 .app 을 만드나 — macOS 26의 로컬 네트워크 권한(TCC) 때문이다. 자세한 배경은
# `relay-launcher.c` 머리 주석과 cctv-setup.md "왜 launchd에 못 올리는가"에 있다.
# 요약하면: launchd가 ffmpeg를 직접 띄우면 카메라에 닿지 못하고, 셸 스크립트를 실행 파일로
# 둔 번들도 안 되며, **네이티브 바이너리를 실행 파일로 둔 번들만** 통과한다.
#
# 여러 번 돌려도 안전하다(기존 것을 걷어내고 다시 만든다).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/TypeLoungeCameraRelay.app"
LABEL="kr.nmwc.typelounge.camera-relay"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RELAY_SCRIPT="$HERE/camera-relay-all.sh"

[ -x "$RELAY_SCRIPT" ] || { echo "camera-relay-all.sh 가 없거나 실행 권한이 없다: $RELAY_SCRIPT"; exit 1; }
command -v clang >/dev/null || { echo "clang 이 없다. Xcode Command Line Tools 를 설치한다: xcode-select --install"; exit 1; }

echo "1/4 번들 빌드"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
clang -O2 -DRELAY_SCRIPT="\"$RELAY_SCRIPT\"" -o "$APP/Contents/MacOS/relay" "$HERE/relay-launcher.c"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>TypeLounge Camera Relay</string>
  <key>CFBundleDisplayName</key><string>TypeLounge Camera Relay</string>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleExecutable</key><string>relay</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSBackgroundOnly</key><true/>
  <key>NSLocalNetworkUsageDescription</key>
  <string>합정 라운지 카메라에서 영상을 받아 오디오를 제거한 뒤 로컬 스트리밍 서버로 넘깁니다.</string>
</dict>
</plist>
EOF

echo "2/4 서명(ad-hoc)"
codesign --force --sign - "$APP"

echo "3/4 LaunchAgent 등록"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/relay</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/typelounge/relay-launch.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/typelounge/relay-launch.log</string>
</dict></plist>
EOF
mkdir -p "$HOME/Library/Logs/typelounge"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "4/4 확인 (25초 기다린다)"
sleep 25
echo
echo "launchd:"
launchctl list | grep "$LABEL" || echo "  ⚠️ 등록 안 됨"
echo
echo "스트림 — 셋 다 true 이고 tracks 가 H264 만이어야 한다:"
curl -s http://127.0.0.1:9997/v3/paths/list | python3 -c "import json,sys
for p in json.load(sys.stdin).get('items',[]):
    print('  ', p['name'], p['ready'], p.get('tracks'))" 2>/dev/null || echo "  ⚠️ MediaMTX API 응답 없음"
echo
echo "안 되면 로그를 본다: ~/Library/Logs/typelounge/camera-*.log"
echo "'No route to host' 가 보이면 로컬 네트워크 권한 문제다 — cctv-setup.md 를 읽는다."
