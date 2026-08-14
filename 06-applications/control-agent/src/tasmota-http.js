/**
 * Tasmota HTTP 우회 — 단일 책임: MQTT가 막혔을 때 기기에 직접 말한다.
 *
 * 기기가 맥과 같은 LAN(192.168.200.0/24)에 있고 `Webserver 2` / `HTTP_API 1`이 켜져 있어
 * `http://<ip>/cm?cmnd=...` 로 명령과 상태 조회가 둘 다 된다. 이게 브릿지가 죽었을 때
 * 남는 유일한 경로다.
 *
 * ⚠️ **ESP8266은 동시 요청에 약하다.** 254개 병렬 스캔에서 실제로 응답을 놓쳤다.
 * 그래서 기기당 직렬화 + 전체 동시 요청 상한을 둔다. 빠른 것보다 도착하는 게 중요하다.
 *
 * ⚠️ **실패는 절대 'OFF'가 되지 않는다.** 못 읽은 것과 꺼진 것은 다르다 —
 * 합치면 켜진 채로 밤을 넘긴 조명이 화면에서 조용히 사라진다(mergeState 주석 참조).
 */

import { extractPower } from "./state.js";
import { getDeviceIp } from "./device-ips.js";

/** ESP8266은 느릴 때가 있다. 짧게 자르면 멀쩡한 기기를 실패로 본다. */
const HTTP_TIMEOUT_MS = 4_000;

/** 전체 동시 요청 상한. 기기가 4대뿐이라 LAN을 두들길 이유가 없다. */
const MAX_CONCURRENT = 2;

let active = 0;
const waiting = [];
/** address → 마지막 요청의 꼬리. 같은 기기에 두 요청이 겹치지 않게 붙인다. */
const chains = new Map();

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

/** 기기당 직렬 + 전역 상한. 앞 요청이 실패해도 뒤 요청은 그대로 이어간다. */
function enqueue(address, fn) {
  const run = async () => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
  const prev = chains.get(address) ?? Promise.resolve();
  const next = prev.then(run, run);
  chains.set(
    address,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/**
 * `http://<ip>/cm?cmnd=<...>`.
 *
 * WebPassword를 아직 안 걸었다(그래서 지금은 인증 파라미터가 없다). 나중에 걸면
 * 아래 두 줄의 주석을 푸는 것으로 끝나도록 URLSearchParams로 조립한다 —
 * 문자열을 이어 붙여 두면 그때 이스케이프까지 손대야 한다.
 */
function buildUrl(ip, cmnd) {
  const url = new URL(`http://${ip}/cm`);
  url.searchParams.set("cmnd", cmnd);
  // url.searchParams.set("user", cfg.tasmotaHttpUser);
  // url.searchParams.set("password", cfg.tasmotaHttpPassword);
  return url;
}

/** 한 번 요청하고 JSON을 돌려준다. 어떤 실패든 null이다(예외를 위로 던지지 않는다). */
async function request(address, cmnd, label) {
  const ip = getDeviceIp(address);
  if (!ip) {
    console.error(`[http] ${address} IP를 모릅니다 — ${label} 불가 (STATUS5를 아직 못 받음)`);
    return { ok: false, reason: "IP 모름", body: null };
  }
  return enqueue(address, async () => {
    try {
      const res = await fetch(buildUrl(ip, cmnd), {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, reason: null, body: await res.json() };
    } catch (e) {
      console.error(`[http] ${address}(${ip}) ${label} 실패:`, e.message);
      return { ok: false, reason: `HTTP 실패: ${e.message}`, body: null };
    }
  });
}

/**
 * 명령을 HTTP로 보낸다. `{ok, reason, power}` — power는 **기기가 실제로 답한 값**이다.
 *
 * `/cm` 응답 자체가 확인이다(`cmnd=POWER%20ON` → `{"POWER":"ON"}`). 보내고 나서 상태를
 * 또 조회하지 않는 이유가 여기 있다 — 요청 하나로 끝나고, 그만큼 기기를 덜 두들긴다.
 */
export async function sendHttpCommand(address, cmnd) {
  const { ok, reason, body } = await request(address, cmnd, `명령(${cmnd})`);
  if (!ok) return { ok: false, reason, power: null };
  console.log(`[http] ${address} ← ${cmnd}`);
  return { ok: true, reason: null, power: extractPower(body) };
}

/**
 * 상태를 HTTP로 읽는다. 델타 `{online, power}` 또는 **null(모름)**.
 *
 * 실패했을 때 `{online:false}`조차 쓰지 않는다 — '내가 못 읽었다'를 '기기가 죽었다'로
 * 바꿔 쓰면 둘을 구분할 방법이 사라진다. 아무것도 안 쓰면 화면이 마지막 보고 시각으로
 * '오래된 상태'라고 정직하게 말한다(cameras.js가 같은 이유로 같은 선택을 한다).
 */
export async function pollHttpState(address) {
  const { ok, body } = await request(address, "Status 0", "상태 조회");
  if (!ok) return null;
  const power = extractPower(body);
  if (power === null) {
    console.error(`[http] ${address} 응답에 전원값이 없습니다 — 상태를 쓰지 않습니다`);
    return null;
  }
  return { online: true, power };
}
