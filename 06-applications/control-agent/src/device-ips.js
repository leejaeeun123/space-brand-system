/**
 * 기기 주소 → LAN IP 캐시 — 단일 책임: HTTP 우회에 필요한 IP를 기억한다.
 *
 * IP는 MQTT의 STATUS5 응답에서만 온다(`cmnd/<addr>/Status 5`). DHCP라 미리 아는 값이
 * 아니고, 스캔은 못 쓴다 — 254개 병렬 요청에 ESP8266이 실제로 응답을 놓쳤다.
 *
 * ⚠️ **디스크 캐시는 부팅용 힌트지 진실이 아니다.** 로컬 브로커가 죽은 채로 에이전트가
 * 켜지면 STATUS5를 받을 길이 없어 우회조차 못 한다. 그 공백만 메우려고 파일에 남긴다.
 * DHCP가 IP를 바꿨으면 이 값은 틀린 값이고, 그때는 HTTP가 실패하고 MQTT가 복구되는
 * 순간 STATUS5가 덮어쓴다. 그래서 이 파일은 커밋하지 않는다(.gitignore).
 */

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const CACHE_PATH = fileURLToPath(new URL("../.device-ips.json", import.meta.url));

/** address → "192.168.200.x" */
const ips = new Map();

export function getDeviceIp(address) {
  return ips.get(address) ?? null;
}

/** 테스트·진단용. 부수효과 없는 스냅샷을 준다. */
export function snapshotDeviceIps() {
  return Object.fromEntries(ips);
}

async function persist() {
  try {
    await fs.writeFile(CACHE_PATH, `${JSON.stringify(snapshotDeviceIps(), null, 2)}\n`);
  } catch (e) {
    // 캐시를 못 써도 기능은 돈다(메모리에는 있다). 다음 부팅이 느려질 뿐이라 죽이지 않는다.
    console.error("[ip] 캐시 저장 실패:", e.message);
  }
}

/**
 * STATUS5에서 받은 IP를 기억한다. 값이 바뀐 경우에만 디스크에 쓴다 —
 * 재접속마다 STATUS5가 오므로, 매번 쓰면 의미 없는 디스크 쓰기가 5분마다 반복된다.
 */
export function rememberDeviceIp(address, ip) {
  if (ips.get(address) === ip) return;
  ips.set(address, ip);
  console.log(`[ip] ${address} → ${ip}`);
  persist().catch(() => {});
}

/**
 * 부팅 시 1회. 파일이 없으면 조용히 넘어간다 — 처음 켜는 맥에는 당연히 없다.
 * 이미 메모리에 있는 값(= STATUS5로 갓 받은 값)은 덮지 않는다. 파일이 더 낡았다.
 */
export async function loadDeviceIps() {
  let raw;
  try {
    raw = await fs.readFile(CACHE_PATH, "utf8");
  } catch {
    return 0;
  }
  try {
    const obj = JSON.parse(raw);
    for (const [address, ip] of Object.entries(obj ?? {})) {
      if (typeof ip === "string" && !ips.has(address)) ips.set(address, ip);
    }
  } catch (e) {
    console.error("[ip] 캐시 파싱 실패 — 무시합니다:", e.message);
    return 0;
  }
  if (ips.size) console.log(`[ip] 마지막으로 알던 기기 IP ${ips.size}건 로드 (낡았을 수 있음)`);
  return ips.size;
}
