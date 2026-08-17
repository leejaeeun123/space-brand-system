/**
 * onvif.js 파싱 회귀 방지 — 단일 책임: 움직임 **종료**가 움직임으로 둔갑하지 않는지 확인한다.
 *
 * CellMotionDetector는 상태형(Property) 이벤트라 시작(IsMotion=true)과 종료(false)가
 * 같은 토픽으로 온다. 종료는 감지 홀드가 풀리는 몇 초 뒤에 오므로, 값을 안 읽으면
 * 유예 안에 나간 손님의 종료 이벤트가 유예 밖 시각을 달고 와 **정상 퇴실을 오탐**시킨다.
 *
 * fetch를 갈아끼워 돌린다(tasmota-http.test.js와 같은 방식) — 실카메라도 LAN도 필요 없다.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isMotion, pull } from "../src/onvif.js";

const realFetch = global.fetch;

test.afterEach(() => {
  global.fetch = realFetch;
});

const CREDS = { user: "u", pass: "p" };
const SUB_URL = "http://192.168.200.99:1024/onvif/sub_0";

/** Tapo TC71 실측 응답과 같은 골격의 NotificationMessage 한 건. */
function notification({ topic, utc, name = "IsMotion", value }) {
  return (
    "<wsnt:NotificationMessage>" +
    `<wsnt:Topic Dialect="d">${topic}</wsnt:Topic>` +
    "<wsnt:Message>" +
    `<tt:Message${utc ? ` UtcTime="${utc}"` : ""} PropertyOperation="Changed">` +
    '<tt:Source><tt:SimpleItem Name="VideoSourceConfigurationToken" Value="vsconf"/></tt:Source>' +
    (value === undefined
      ? "<tt:Data></tt:Data>"
      : `<tt:Data><tt:SimpleItem Name="${name}" Value="${value}"/></tt:Data>`) +
    "</tt:Message></wsnt:Message></wsnt:NotificationMessage>"
  );
}

function envelope(inner) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>' +
    `<tev:PullMessagesResponse>${inner}</tev:PullMessagesResponse>` +
    "</s:Body></s:Envelope>"
  );
}

function respondWith(xml, status = 200) {
  global.fetch = async () => new Response(xml, { status });
}

test("IsMotion=true 한 건 → 이벤트 하나, active true, UtcTime을 그대로 싣는다", async () => {
  respondWith(envelope(
    notification({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", utc: "2026-08-18T00:02:50Z", value: "true" }),
  ));
  const events = await pull(SUB_URL, CREDS);
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "Motion");
  assert.equal(events[0].active, true);
  assert.equal(events[0].at.toISOString(), "2026-08-18T00:02:50.000Z");
  assert.equal(isMotion(events[0]), true);
});

test("IsMotion=false(움직임 종료)는 이벤트로는 남되 움직임으로 치지 않는다", async () => {
  respondWith(envelope(
    notification({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", utc: "2026-08-18T00:03:05Z", value: "false" }),
  ));
  const events = await pull(SUB_URL, CREDS);
  assert.equal(events.length, 1);
  assert.equal(events[0].active, false);
  assert.equal(isMotion(events[0]), false);
});

test("UtcTime이 없는 알림은 버린다 — 시각을 모르는 감지는 이 기능에 쓸 수 없다", async () => {
  respondWith(envelope(
    notification({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", utc: null, value: "true" }),
  ));
  assert.deepEqual(await pull(SUB_URL, CREDS), []);
});

test("여러 건 + Tamper 혼합 → 파싱은 전부, 움직임 판정은 Motion만", async () => {
  respondWith(envelope(
    notification({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", utc: "2026-08-18T00:02:50Z", value: "true" }) +
      notification({ topic: "tns1:VideoSource/MotionAlarm/Tamper", utc: "2026-08-18T00:02:51Z", name: "IsTamper", value: "true" }),
  ));
  const events = await pull(SUB_URL, CREDS);
  assert.equal(events.length, 2);
  assert.deepEqual(events.filter(isMotion).map((e) => e.topic), ["Motion"]);
});

test("Data에 값이 아예 없으면(active=null) 움직임으로 친다 — 조용한 고장이 더 나쁘다", async () => {
  // FW가 바뀌어 파서가 값을 놓치는 날, 전부 버리면 기능이 꺼진 채 아무도 모른다.
  respondWith(envelope(
    notification({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", utc: "2026-08-18T00:02:50Z" }),
  ));
  const events = await pull(SUB_URL, CREDS);
  assert.equal(events[0].active, null);
  assert.equal(isMotion(events[0]), true);
});

test("Fault 응답은 던진다", async () => {
  respondWith(
    '<s:Envelope><s:Body><s:Fault><s:Reason><s:Text xml:lang="en">Authority failure</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>',
  );
  await assert.rejects(() => pull(SUB_URL, CREDS), /Authority failure/);
});

test("유예 경계 회귀 — 유예 안 시작(02:50) + 유예 밖 종료(03:05) 시퀀스에서 움직임 시각은 02:50뿐이다", async () => {
  // 퇴실 09:00(KST) + 유예 3분 = 09:03 이후만 판정 대상인 상황. 손님이 09:02:50에 마지막으로
  // 움직이며 나갔고, 카메라 감지 홀드가 09:03:05에 풀리며 종료 이벤트를 보냈다.
  // 종료를 세면 '유예 밖 움직임'이 생겨 정상 퇴실에 퇴실 독려가 나간다.
  respondWith(envelope(
    notification({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", utc: "2026-08-18T00:02:50Z", value: "true" }) +
      notification({ topic: "tns1:RuleEngine/CellMotionDetector/Motion", utc: "2026-08-18T00:03:05Z", value: "false" }),
  ));
  const events = await pull(SUB_URL, CREDS);

  // motion.js watchOne과 같은 방식으로 '마지막 움직임'을 고른다.
  let motionAt = null;
  for (const e of events) {
    if (!isMotion(e)) continue;
    if (motionAt === null || e.at > motionAt) motionAt = e.at;
  }
  assert.equal(motionAt?.toISOString(), "2026-08-18T00:02:50.000Z");
});
