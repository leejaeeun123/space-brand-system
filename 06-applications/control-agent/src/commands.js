/**
 * 명령 수신·실행 — 단일 책임: 큐에 들어온 명령을 MQTT로 내보낸다.
 *
 * 수신은 Supabase Realtime(아웃바운드 WebSocket)이다. 합정 맥은 NAT 뒤라 서버가 우리를
 * 부를 수 없고, 폴링은 조명에 필요한 1초 반응성을 맞추려면 무료 한도를 넘긴다.
 */

import { COMMAND_TTL_MS, CONFIRM_TIMEOUT_MS } from "./config.js";
import { isBridgeUp, publish } from "./mqtt.js";
import {
  awaitConfirmation,
  decideDelivery,
  isSuperseded,
  markLatestCommand,
  parseCommandTopic,
} from "./delivery.js";
import { sendHttpCommand } from "./tasmota-http.js";

/**
 * 이 명령이 너무 오래됐나.
 *
 * 맥이 꺼져 있던 동안 쌓인 명령을 그대로 재생하면 **새벽 3시에 조명이 켜진다.**
 * 사람이 그 순간에 누른 버튼이고, 그 순간은 지났다. 늦은 실행보다 미실행이 안전하다.
 */
export function isExpired(requestedAt, now = Date.now()) {
  return now - Date.parse(requestedAt) > COMMAND_TTL_MS;
}

export async function executeCommand(row, ctx) {
  const { mqttClient, registry } = ctx;
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

  const cmd = parseCommandTopic(topic, payload);
  // 이 주소로 지금까지 본 것 중 가장 최신으로 기록해 둔다. 이 명령이 나중에(Tier 3
  // 타임아웃 뒤) HTTP로 우회하려 할 때, 그 사이 더 최신 명령이 왔으면 우회를 막는 데 쓴다.
  if (cmd) markLatestCommand(cmd.address, Date.parse(row.requested_at));

  const first = decideDelivery({
    localConnected: mqttClient.connected,
    bridgeUp: isBridgeUp(),
  });

  if (first.action === "http") {
    console.warn(`[cmd] ${first.reason} → HTTP로 우회합니다: ${topic} = ${payload}`);
    await deliverByHttp(row, ctx, cmd, first);
    return;
  }

  // **발행보다 먼저 확인 대기를 건다.** 로컬 PUBACK은 1ms 안쪽이고 기기 응답은 수십 ms라
  // 틈이 좁지만, 그 틈에 stat이 들어오면 기다리는 쪽이 없어 그냥 흘러가고 — 멀쩡히 도착한
  // 명령을 4초 기다렸다가 HTTP로 한 번 더 보내게 된다. 순서를 바꾸면 그 틈이 아예 없다.
  // 우회할 수 없는 명령(cmnd 문법이 아님)은 기다려도 할 수 있는 게 없으니 예전대로 둔다.
  const confirmation = cmd
    ? awaitConfirmation(cmd.address, cmd.expectPower, CONFIRM_TIMEOUT_MS)
    : null;

  try {
    await publish(mqttClient, topic, payload);
    console.log(`[cmd] 발행 ${topic} = ${payload}`);
  } catch (e) {
    await registry.markCommand(row.id, "failed", e.message);
    console.error("[cmd] 발행 실패:", e.message);
    // 걸어둔 대기는 4초 뒤 스스로 false로 풀린다(거절이 아니라 해제라 아무도 안 깨진다).
    return;
  }

  // **발행 성공은 도착이 아니다.** 기기가 스스로 보고할 때까지 기다렸다가 판정한다.
  const confirmed = confirmation ? await confirmation : true;

  const second = decideDelivery({ localConnected: true, bridgeUp: true, confirmed });
  if (second.action === "http") {
    console.warn(`[cmd] ${second.reason} → HTTP로 다시 보냅니다: ${topic} = ${payload}`);
    await deliverByHttp(row, ctx, cmd, second);
    return;
  }
  await registry.markCommand(row.id, "sent");
}

/**
 * 기기 HTTP로 직접 보낸다. **여기서만 `sent`가 붙는다** — 기기가 응답으로 실제 전원값을
 * 돌려주기 때문이다(sihas-bridge가 명령 후 실측을 다시 읽는 것과 같은 이유).
 *
 * 실패는 `failed`로 남긴다. `pending`으로 두면 오늘과 똑같이 아무도 모르는 채로 조용히
 * 사라지고, 사람은 조명이 왜 안 켜지는지 화면에서 알 방법이 없다.
 */
async function deliverByHttp(row, { registry, applyState }, cmd, decision) {
  // 확인 대기(Tier 3)에 몇 초를 썼다. 그 사이에 명령이 늙었으면 여기서 버린다 —
  // 새벽 3시에 조명을 켜지 않는다는 규칙은 우회 경로에도 똑같이 적용된다.
  if (isExpired(row.requested_at)) {
    await registry.markCommand(row.id, "expired");
    console.log(`[cmd] 우회 직전 만료 — 실행하지 않음: ${row.id}`);
    return;
  }

  if (!cmd) {
    await registry.markCommand(row.id, "failed", `${decision.reason} (HTTP 우회 불가한 토픽)`);
    console.error("[cmd] cmnd 토픽이 아니라 우회할 수 없습니다:", row.id);
    return;
  }

  // 확인 대기(최대 4초) 사이에 같은 기기로 더 최신 명령이 들어왔으면, 이 낡은 명령을
  // HTTP로 내보내지 않는다 — 내보내면 사용자의 최신 의도(예: 방금 켠 ON)를 되돌리게 된다.
  // "failed"를 쓰는 이유: status 컬럼이 pending/sent/expired/failed로 제약돼 있어(마이그레이션
  // `20260803160000_device_commands.sql`) 새 값을 추가하려면 스키마 변경이 필요하다 —
  // 지금은 error 문구로 구분한다.
  if (isSuperseded(cmd.address, Date.parse(row.requested_at))) {
    await registry.markCommand(row.id, "failed", `${decision.reason} → 더 최신 명령에 밀림(우회 안 함)`);
    console.log(`[cmd] 최신 명령에 밀려 우회하지 않음: ${row.id}`);
    return;
  }

  const { ok, reason, power } = await sendHttpCommand(cmd.address, cmd.cmnd);
  if (!ok) {
    await registry.markCommand(row.id, "failed", `${decision.reason} → ${reason}`);
    return;
  }

  await registry.markCommand(row.id, "sent");
  // 낙관값이 아니라 **기기가 답한 값**을 쓴다. 응답에 전원이 없으면 아무것도 안 쓴다.
  if (power !== null) await applyState?.(cmd.address, { online: true, power });
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
