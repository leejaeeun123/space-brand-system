/**
 * 명령 수신·실행 — 단일 책임: 큐에 들어온 명령을 MQTT로 내보낸다.
 *
 * 수신은 Supabase Realtime(아웃바운드 WebSocket)이다. 합정 맥은 NAT 뒤라 서버가 우리를
 * 부를 수 없고, 폴링은 조명에 필요한 1초 반응성을 맞추려면 무료 한도를 넘긴다.
 */

import { COMMAND_TTL_MS } from "./config.js";
import { publish } from "./mqtt.js";

/**
 * 이 명령이 너무 오래됐나.
 *
 * 맥이 꺼져 있던 동안 쌓인 명령을 그대로 재생하면 **새벽 3시에 조명이 켜진다.**
 * 사람이 그 순간에 누른 버튼이고, 그 순간은 지났다. 늦은 실행보다 미실행이 안전하다.
 */
export function isExpired(requestedAt, now = Date.now()) {
  return now - Date.parse(requestedAt) > COMMAND_TTL_MS;
}

export async function executeCommand(row, { mqttClient, registry }) {
  const { topic, payload } = row.payload ?? {};
  if (!topic || payload === undefined) {
    // Edge Function이 토픽을 완성해 넣는다 — 없다는 건 계약이 깨졌다는 뜻이라 드러낸다.
    await registry.markCommand(row.id, "failed", "topic/payload 누락");
    console.error("[cmd] payload에 topic이 없습니다:", row.id);
    return;
  }

  if (isExpired(row.requested_at)) {
    await registry.markCommand(row.id, "expired");
    console.log(`[cmd] 만료 — 실행하지 않음: ${topic} = ${payload}`);
    return;
  }

  if (!mqttClient.connected) {
    // pending으로 그대로 둔다 — 재접속 시 drainPending이 다시 집는다(그때도 TTL을 본다).
    console.warn("[cmd] 브로커 연결 없음 — 대기 상태로 둡니다:", row.id);
    return;
  }

  try {
    await publish(mqttClient, topic, payload);
    await registry.markCommand(row.id, "sent");
    console.log(`[cmd] 발행 ${topic} = ${payload}`);
  } catch (e) {
    await registry.markCommand(row.id, "failed", e.message);
    console.error("[cmd] 발행 실패:", e.message);
  }
}

/** 에이전트가 꺼져 있던 동안 쌓인 명령 처리. 대부분 만료로 버려지는 게 정상이다. */
export async function drainPending(ctx) {
  const rows = await ctx.registry.pendingCommands();
  if (!rows.length) return;
  console.log(`[cmd] 대기 중이던 명령 ${rows.length}건 처리`);
  for (const row of rows) await executeCommand(row, ctx);
}

export function subscribeCommands(sb, ctx) {
  return sb
    .channel("device-commands")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "device_commands" },
      (payload) => {
        executeCommand(payload.new, ctx).catch((e) =>
          console.error("[cmd] 처리 중 예외:", e)
        );
      },
    )
    .subscribe((status) => {
      console.log(`[realtime] ${status}`);
      // 재구독 성공 시점에 밀린 것을 한 번 훑는다 — 끊겨 있던 동안의 INSERT는 못 받았다.
      if (status === "SUBSCRIBED") drainPending(ctx).catch(() => {});
    });
}
