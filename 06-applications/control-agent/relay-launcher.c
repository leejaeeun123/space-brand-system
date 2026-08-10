/* TypeLounge 카메라 재발행 런처 — 하는 일은 exec 한 줄이 전부다.
 *
 * 왜 C 파일이 여기 있나
 * ─────────────────────
 * macOS 26은 로컬 네트워크 접근을 **바이너리 단위**로 통제한다(TCC). 그런데 launchd가
 * 띄운 Homebrew ffmpeg 는 그 통제에서 카메라 IP에 닿지 못한다 — `No route to host` 가
 * 나고, 시스템 설정의 '로컬 네트워크' 목록에 항목조차 안 생겨 토글로 풀 수도 없다.
 * (Apple 서명 도구인 `nc` 는 launchd 에서도 통과한다. launchd 전체가 막힌 게 아니다.)
 *
 * .app 번들로 감싸면 번들이 권한 주체가 되는데, **실행 파일이 셸 스크립트면 안 된다** —
 * 프로세스가 `/bin/bash` 로 잡혀 번들이 주체로 인식되지 않는다(2026-08-10 실측: ad-hoc
 * 서명한 셸 스크립트 번들은 launchd·open 양쪽 다 실패, 권한 프롬프트도 안 떴다).
 *
 * 그래서 네이티브 바이너리가 필요하다. 이 파일이 그것이고, 여기서 exec 한 자식
 * (bash → ffmpeg)이 번들이 받은 권한을 그대로 물려받는다. 실제로 이 방식으로 통과했다.
 *
 * 빌드·설치는 `install-camera-relay.sh` 가 한다. 직접 컴파일할 일은 없다.
 */
#include <unistd.h>
#include <stdio.h>

/* 설치 스크립트가 -DRELAY_SCRIPT=... 로 실제 경로를 박아 넣는다.
   경로를 소스에 하드코딩하지 않는 이유는 레포 위치가 맥마다 다를 수 있어서다. */
#ifndef RELAY_SCRIPT
#error "RELAY_SCRIPT 가 정의되지 않았다. install-camera-relay.sh 로 빌드한다."
#endif

int main(void) {
    execl("/bin/bash", "bash", RELAY_SCRIPT, (char *)NULL);
    /* execl 은 성공하면 돌아오지 않는다. 여기 왔다는 건 실패했다는 뜻이다. */
    perror("relay: camera-relay-all.sh 실행 실패");
    return 1;
}
