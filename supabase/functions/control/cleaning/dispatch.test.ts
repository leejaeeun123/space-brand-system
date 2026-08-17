/**
 * `dispatch()`의 smsOnly 경계 테스트 — **이 레포에서 가장 중요한 분리 하나를 3중으로 잰다.**
 *
 * 비밀번호 블록(`Outgoing.smsOnly`)은 문자에만 가야 한다. `body`는 세 곳(문자·`cleaning_sms`
 * 장부·Mattermost 채널)으로 흐르므로, 경계가 무너지는 방향은 셋이다:
 *   ① 장부 — claim이 insert하는 payload에 블록이 섞인다
 *   ② 문자 — 발송 직전 합성이 빠져 담당자가 비밀번호를 못 받는다 (반대 방향의 실패)
 *   ③ 채널 — 실패 알림(notifyFailed)에 넘어가는 body·error에 블록이 실린다
 * 셋 다 assert해야 어느 방향의 회귀도 잡힌다. 픽스처 값은 실값과 무관한 자리표시다.
 *
 * 실행: `deno test --allow-env supabase/functions/control/cleaning/dispatch.test.ts`
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { SolapiConfig, SendResult } from "../sms/solapi.ts";
import { dispatch, type Outgoing } from "./dispatch.ts";
import type { ScheduleSnapshot } from "./diff.ts";

const PIN_BLOCK = "■ 출입\n현관 비밀번호 0000000\n\n■ 어드민\n비밀번호 XXXXXXXXXXXXXXXX";

const CFG: SolapiConfig = { apiKey: "k", apiSecret: "s", sender: "01000000000" };

function outgoing(): Outgoing {
  return {
    kind: "digest",
    date: "2026-08-18",
    body: "[타입라운지] 8/18(화) 청소 안내\n\n오늘 예약이 없어요.",
    snapshot: { date: "2026-08-18", entries: [] } as unknown as ScheduleSnapshot,
    fingerprint: null,
    smsOnly: PIN_BLOCK,
  };
}

/** dispatch가 쓰는 체인(insert→select→single, update→eq)만 구현하고 payload를 붙잡는다. */
function fakeSb(captured: { inserts: Record<string, unknown>[]; updates: Record<string, unknown>[] }) {
  const table = {
    insert: (row: Record<string, unknown>) => {
      captured.inserts.push(row);
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { id: 1 }, error: null }),
        }),
      };
    },
    update: (row: Record<string, unknown>) => {
      captured.updates.push(row);
      return { eq: () => Promise.resolve({ data: null, error: null }) };
    },
  };
  return { from: () => table } as unknown as SupabaseClient;
}

Deno.test("smsOnly 경계 — 장부에는 없고, 문자에는 있고, 성공 알림에도 없다", async () => {
  const captured = { inserts: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
  const sentTexts: string[] = [];
  const notified: string[] = [];

  const status = await dispatch(fakeSb(captured), CFG, "01048109142", outgoing(), {
    send: (_cfg, _to, text) => {
      sentTexts.push(text);
      return Promise.resolve({ ok: true, groupId: "g1" } as SendResult);
    },
    notifySent: (_kind, body) => {
      notified.push(body);
      return Promise.resolve();
    },
    notifyFailed: () => Promise.resolve(),
  });

  assertEquals(status, "sent");

  // ① 장부(claim insert payload) — 비밀번호 블록이 없어야 한다.
  assertEquals(captured.inserts.length, 1);
  assertEquals(String(captured.inserts[0].body).includes("0000000"), false);
  assertEquals(String(captured.inserts[0].body).includes("현관"), false);

  // ② 문자 — 발송 직전 합성으로 블록이 **있어야** 한다. 없으면 담당자가 문을 못 연다.
  assertEquals(sentTexts.length, 1);
  assertStringIncludes(sentTexts[0], "현관 비밀번호 0000000");
  assertStringIncludes(sentTexts[0], outgoing().body);

  // ③ 채널(notifySent body) — 블록이 없어야 한다.
  assertEquals(notified.length, 1);
  assertEquals(notified[0].includes("0000000"), false);
});

Deno.test("smsOnly 경계 — 실패 시 장부 error와 실패 알림에도 비밀번호가 없다", async () => {
  const captured = { inserts: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
  const failedArgs: { body: string; error: string }[] = [];

  const status = await dispatch(fakeSb(captured), CFG, "01048109142", outgoing(), {
    // 벤더 거절 — error는 solapi.describeRejected가 만든 화이트리스트 문자열이라는 전제이고,
    // 그 전제 자체는 solapi.test.ts의 에코 가드가 지킨다. 여기서는 dispatch가 그 error와
    // body를 그대로 흘리는 두 경로(장부 update·notifyFailed)에 블록이 안 섞이는 것을 잰다.
    send: () => Promise.resolve({ ok: false, failure: "rejected", error: "1061: 잔액 부족" } as SendResult),
    notifySent: () => Promise.resolve(),
    notifyFailed: (_kind, body, error) => {
      failedArgs.push({ body, error });
      return Promise.resolve();
    },
  });

  assertEquals(status, "failed");

  // 장부의 실패 기록(update payload)에 비밀번호가 없다.
  assertEquals(captured.updates.length, 1);
  assertEquals(JSON.stringify(captured.updates[0]).includes("0000000"), false);

  // 실패 알림으로 넘어간 body·error에 비밀번호가 없다.
  assertEquals(failedArgs.length, 1);
  assertEquals(failedArgs[0].body.includes("0000000"), false);
  assertEquals(failedArgs[0].error.includes("0000000"), false);
});
