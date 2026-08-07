/**
 * 명령 발행 + 장부 기록 — 단일 책임: 모든 기기 명령이 지나가는 하나의 문.
 *
 * `handlers/command.ts`를 감싸기만 한다. 그쪽에 기록을 끼워 넣지 않은 이유가 둘이다 —
 * 이미 배포돼 돌아가는 제어 경로라 손댈수록 위험하고, 기록은 제어와 다른 관심사다.
 *
 * **여기를 우회해 `command()`를 직접 부르면 그 조작은 장부에 남지 않는다.** 그러면 나중에
 * 그 변화가 '설명할 명령이 없는 변화' = 현장 조작으로 잘못 잡힌다. 기기를 움직이는 코드는
 * 반드시 이 문을 지난다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { command } from "../handlers/command.ts";
import { HandlerError } from "../handlers/shared.ts";
import * as events from "./events.ts";
import type { EventKind } from "./events.ts";

/** 명령 본문에서 장부에 적을 값(온도·모드·풍량)을 꺼낸다. 전원 명령은 값이 없다. */
function valueOf(body: Record<string, unknown>): string | null {
  const v = body.value;
  return v === undefined || v === null ? null : String(v);
}

export async function issue(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  kind: EventKind,
  opts: { silent?: boolean } = {},
): Promise<unknown> {
  const deviceId = String(body.device_id ?? "");
  const action = String(body.command ?? "");

  try {
    const result = await command(sb, body);

    // **조명의 'sent'는 '기기가 실행했다'가 아니다** — 큐에 넣었다는 뜻이고, 현장 맥이 죽어
    // 있으면 60초 뒤 만료돼 조용히 버려진다. 이걸 'ok'로 뭉개면 조명이 밤새 켜져 있는데
    // 채널엔 '퇴실 종료 성공'만 남는다. `command.ts`가 이 차이를 흐리지 말라고 못박은 것과
    // 같은 이유로, 장부에도 그대로 남겨 표에 '보냄(반영 미확인)'으로 찍는다.
    const queued = (result as { status?: string } | null)?.status === "sent";

    await events.record(sb, {
      device_id: deviceId,
      kind,
      action,
      value: valueOf(body),
      status: "ok",
      detail: queued ? "sent" : null,
      silent: opts.silent,
    });
    return result;
  } catch (e) {
    // 404(없는 기기)는 적지 않는다 — 외래키가 걸려 있어 insert 자체가 실패하고,
    // 손님이 오래된 화면에서 사라진 기기를 누르면 로그만 시끄러워진다.
    const notFound = e instanceof HandlerError && e.status === 404;
    if (deviceId && !notFound) {
      await events.record(sb, {
        device_id: deviceId,
        kind,
        action,
        value: valueOf(body),
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
        // 실패는 조용히 넘기지 않는다 — 반복되더라도 사람이 봐야 하는 신호다.
      });
    }
    throw e;
  }
}
