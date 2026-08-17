/**
 * 움직임 감시 진입점 — 퇴실 독려 판정의 재료를 모은다.
 *
 * 사용: `node --env-file=.env src/motion-watch.js lounge_left:192.168.200.193 ...`
 * 실제로는 `camera-relay-all.sh`가 띄운다. 왜 거기냐는 `motion.js` 머리 주석에 있다.
 *
 * **`index.js`(control-agent)와 별개 프로세스다.** 합칠 수 없는 이유가 권한이다 —
 * control-agent는 launchd 직속이라 카메라 LAN에 못 붙는다. 이 파일만 relay `.app` 아래에서
 * 돌아야 하고, 그래서 설정도 스스로 읽는다(`loadConfig`는 MQTT를 필수로 요구해 쓸 수 없다).
 */

import { createClient } from "@supabase/supabase-js";
import { startMotionWatch } from "./motion.js";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CAM_RTSP_USER", "CAM_RTSP_PASS"];

function loadCameras(args) {
  const cameras = [];
  for (const arg of args) {
    const [path, ip] = arg.split(":");
    if (!path || !ip) {
      console.error(`[motion] 인자 형식이 'path:ip'가 아니다: ${arg}`);
      continue;
    }
    cameras.push({ path, ip });
  }
  return cameras;
}

function main() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[motion] 필수 환경변수 누락: ${missing.join(", ")}`);
    process.exit(1);
  }

  const cameras = loadCameras(process.argv.slice(2));
  if (!cameras.length) {
    // 인자가 없으면 **감시할 것이 없는 게 아니라 호출이 잘못된 것**이다. 조용히 살아 있으면
    // 감시가 도는 줄 알고 아무도 안 본다.
    console.error("[motion] 감시할 카메라를 인자로 받지 못했다. 예: lounge_left:192.168.200.193");
    process.exit(1);
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  startMotionWatch(sb, cameras, {
    user: process.env.CAM_RTSP_USER,
    pass: process.env.CAM_RTSP_PASS,
  })
    .then((stop) => {
      const shutdown = () => {
        console.log("[motion] 종료합니다.");
        stop();
        // 구독 해제에 시간을 조금 준다. 안 끊고 나가면 카메라에 죽은 구독이 남는다.
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((e) => {
      console.error("[motion] 시작 실패:", e);
      process.exit(1);
    });
}

main();
