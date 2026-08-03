/** 핸들러 공통 — 오류 타입과 ThinQ 클라이언트 팩토리. */

import { loadConfig, ThinQClient } from "../thinq/client.ts";

/** 호출측이 HTTP 상태코드로 바꿀 수 있는 오류. */
export class HandlerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HandlerError";
  }
}

export function thinqConfigured(): boolean {
  return loadConfig() !== null;
}

export function thinqClient(): ThinQClient {
  const cfg = loadConfig();
  if (!cfg) {
    throw new HandlerError(503, "ThinQ 미설정 — THINQ_PAT·THINQ_CLIENT_ID·THINQ_API_KEY 필요");
  }
  return new ThinQClient(cfg);
}
