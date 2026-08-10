#!/bin/bash
# 카메라 RTSP를 오디오만 떼어 로컬 MediaMTX로 재발행한다.
#
# 왜 필요한가: 카메라 3대 모두 마이크를 끌 수 없어 RTSP에 pcm_alaw 트랙이 실려 나온다.
# MediaMTX에 직접 물리면 그 오디오가 그대로 흘러 「개인정보 보호법」 §25⑤ 위반이 된다.
# 그래서 여기서 -an 으로 오디오를 버린 뒤 무음 스트림만 넘긴다.
# **-an 을 지우면 위법이다.**
#
# 사용: camera-republish.sh <path> <camera-ip>
# 자격증명은 같은 디렉터리 .env 의 CAM_RTSP_USER / CAM_RTSP_PASS 에서 읽는다.

set -euo pipefail

PATH_NAME="${1:?path 인자가 없다 (office|lounge_left|lounge_right)}"
CAM_IP="${2:?카메라 IP 인자가 없다}"

cd "$(dirname "$0")"
set -a; . ./.env; set +a
: "${CAM_RTSP_USER:?.env 에 CAM_RTSP_USER 가 없다}"
: "${CAM_RTSP_PASS:?.env 에 CAM_RTSP_PASS 가 없다}"

# -rtsp_transport tcp: UDP로 받으면 패킷 손실이 그대로 깨진 화면이 된다.
# -use_wallclock_as_timestamps 1: 이 카메라는 타임스탬프를 안 실어 보낸다("Timestamps are unset").
#   그대로 두면 Non-monotonic DTS 경고가 초당 수십 줄씩 쌓여 30시간에 115MB를 만들었다(실측).
# -nostats -loglevel error: 진행률·경고 스팸을 끈다. Broken pipe 같은 진짜 실패는 error라 남는다.
exec /usr/local/bin/ffmpeg \
  -nostdin -nostats -loglevel error \
  -rtsp_transport tcp \
  -use_wallclock_as_timestamps 1 \
  -i "rtsp://${CAM_RTSP_USER}:${CAM_RTSP_PASS}@${CAM_IP}:554/stream1" \
  -an -c:v copy \
  -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:8554/${PATH_NAME}"
