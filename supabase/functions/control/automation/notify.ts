/**
 * Mattermost 발송 — 단일 책임: 선점한 이벤트를 종류별로 묶어 보내고, 결과에 따라 되돌린다.
 *
 * 메시지 조립은 `message.ts`에 있다. 여기는 네트워크와 **그 실패**만 다룬다 — 나눠 놓으니
 * 조립 규칙은 웹훅 없이 테스트되고, 이 파일은 실패 분기에만 집중한다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as events from "./events.ts";
import type { EventKind, EventRow } from "./events.ts";
import { buildMessage, orderGroups } from "./message.ts";

/**
 * 웹훅 주소. 기기 전용이 있으면 그쪽, 없으면 예약 알림과 같은 채널로 간다.
 *
 * 지금은 예약 알림과 같은 채널을 쓰기로 했다(형운 결정, 2026-08-07). 기기 알림이 훨씬 잦아
 * 예약 알림을 덮게 되면, **코드를 고치지 않고** `MATTERMOST_DEVICE_WEBHOOK_URL` 시크릿만
 * 넣어 분리할 수 있게 이 순서로 둔다.
 */
function webhookUrl(): string | null {
  return Deno.env.get("MATTERMOST_DEVICE_WEBHOOK_URL") ??
    Deno.env.get("MATTERMOST_WEBHOOK_URL") ?? null;
}

/**
 * 발송 결과. **일시적 실패와 영구적 실패를 가르는 것이 이 타입의 존재 이유다.**
 *
 * 예전엔 boolean이었고 실패는 전부 되돌렸다. 그런데 되돌린 것은 다음 틱에 **오래된 것부터**
 * 다시 꺼내지므로, 영원히 거절당하는 묶음 하나가 큐의 머리에 눌러앉아 뒤의 알림까지 막는다
 * (7일 정리 크론이 지울 때까지).
 *
 * 그래서 400만 버린다 — '이 메시지가 잘못됐다'는 뜻이라 다시 보내도 결과가 같다.
 * 401·403·404는 **설정이 잘못된 것**이라 사람이 고치면 되살아나므로 되돌린다. 여기를
 * 4xx 전체로 넓히면 웹훅 주소 하나 잘못 넣었을 때 모든 알림이 조용히 사라진다.
 */
type PostResult = "sent" | "retry" | "drop";

/** 발송. **어떤 예외도 밖으로 던지지 않는다** — 알림 실패가 제어를 망가뜨리면 안 된다. */
async function post(text: string): Promise<PostResult> {
  const url = webhookUrl();
  if (!url) {
    console.warn("MATTERMOST_WEBHOOK_URL 미설정 — 알림을 건너뛴다");
    // **'sent'로 본다(=소진).** 설정 안 한 것은 '나중에 보낼 것'이 아니라 '안 보내기로 한 것'이다.
    // 되돌리면 미발송 이벤트가 영원히 쌓이고(정리 크론은 발송된 것만 30일로 지운다) 테이블이 큰다.
    return "sent";
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.ok) return "sent";

    const body = await res.text().catch(() => "");
    const permanent = res.status === 400;
    console.error(
      `Mattermost 알림 ${permanent ? "거절 — 버린다" : "실패 — 다시 시도한다"} (${res.status})`,
      body,
    );
    return permanent ? "drop" : "retry";
  } catch (e) {
    console.error("Mattermost 알림 예외", e);
    return "retry";
  }
}

/**
 * 아직 안 보낸 이벤트를 종류별로 묶어 보낸다.
 *
 * **선점 먼저, 발송 나중.** `automate`는 누구나 부를 수 있어 두 호출이 겹치면 같은 알림이
 * 두 번 갈 수 있는데, 선점이 그걸 막는다(`events.claimPending`).
 */
export async function flush(
  sb: SupabaseClient,
  names: Map<string, string>,
  now: Date,
): Promise<number> {
  const pending = await events.claimPending(sb, now);
  if (!pending.length) return 0;

  const byKind = new Map<EventKind, EventRow[]>();
  for (const e of pending) {
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }

  let sent = 0;
  const retry: number[] = [];
  let halted = false;

  // **일어난 순서대로 올린다.** 예전엔 종류별 고정 순서(중요도순)로 보냈는데, 채널은 발송
  // 순서가 곧 타임라인이라 그러면 시간이 거꾸로 보인다 — 손님이 조명을 켜고(00:59:41) 스윕이
  // 끈 것(01:00:01)이 위에 올라왔다(2026-08-08 형운 지적). 채널은 우선순위 목록이 아니라
  // 타임라인이다. 급한 것은 순서가 아니라 제목의 ⚠️가 드러낸다.
  //
  // 종류를 열거하지 않게 된 덕분에, 새 EventKind가 생겨도 목록 갱신을 빠뜨려 조용히 안 나가는
  // 일이 원천적으로 없어졌다.
  for (const [kind, rows] of orderGroups(byKind)) {
    // **앞이 밀리면 뒤도 미룬다.** 먼저 일어난 묶음이 재시도로 넘어갔는데 나중 묶음만 나가면,
    // 다음 틱에 그게 뒤늦게 붙어 채널에서 시간이 거꾸로 흐른다. 방금 고친 것과 같은 문제가
    // 틱을 가로질러 다시 생기는 셈이라, 순서를 지키려면 여기서 멈추는 수밖에 없다.
    if (halted) {
      retry.push(...rows.map((r) => r.id));
      continue;
    }

    const result = await post(buildMessage(kind, rows, names));
    if (result === "sent") {
      sent += rows.length;
    } else if (result === "drop") {
      // 선점을 유지한 채 넘어간다 = 버린다. 장부에는 남아 있어 나중에 원인을 볼 수 있다.
      console.error(`알림 ${rows.length}건을 버린다 — ${kind}`);
    } else {
      retry.push(...rows.map((r) => r.id));
      halted = true;
    }
  }

  await events.release(sb, retry);
  return sent;
}
