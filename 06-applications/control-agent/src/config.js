/** 환경변수 로딩 + 검증 — 단일 책임: 설정이 반쪽이면 시작조차 못 하게 막는다. */

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MQTT_URL"];

/**
 * 명령이 이 시간보다 오래됐으면 **실행하지 않고 버린다**(expired).
 *
 * 맥이 몇 시간 꺼져 있다가 켜졌을 때 밀린 명령을 그대로 재생하면 새벽 3시에 조명이 켜진다.
 * "늦게라도 실행"이 맞는 명령이 아니다 — 사람이 그 순간에 누른 버튼이고, 그 순간은 지났다.
 */
export const COMMAND_TTL_MS = 60_000;

export function loadConfig() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[config] 필수 환경변수 누락: ${missing.join(", ")}`);
    console.error("[config] .env.example을 참고해 .env를 채우세요.");
    process.exit(1);
  }
  return {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    mqttUrl: process.env.MQTT_URL,
    // mosquitto에 인증을 걸었으면 채운다. 비워두면 익명 접속을 시도한다.
    mqttUser: process.env.MQTT_USER || undefined,
    mqttPassword: process.env.MQTT_PASSWORD || undefined,
  };
}
