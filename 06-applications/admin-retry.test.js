/**
 * admin.html의 CCTV 재연결 상태머신 검증.
 *
 * ── 왜 HTML에서 함수를 떼어내 돌리는가 ──────────────────────────────────────
 * admin.html은 빌드 단계가 없는 단일 파일이라 import할 모듈이 없다. 그렇다고 이 로직을
 * 검증 없이 두면 안 되는 이유는 **틀렸을 때의 증상이 조용하기 때문**이다 — 재연결이 안
 * 되면 카드가 검은 화면으로 남을 뿐 오류가 어디에도 안 뜨고, 그걸 알아차리는 시점은
 * 대개 "그때 영상 좀 봅시다"라고 누가 말한 뒤다.
 *
 * 그래서 함수 본문을 이름으로 잘라내 스텁 환경에서 돌린다. 잘라내기가 실패하면 조용히
 * 통과하지 않고 **즉시 죽는다**(아래 extract의 assert) — 구조가 바뀌었는데 테스트만
 * 초록으로 남는 게 제일 나쁘다.
 *
 * 시계도 스텁이다. 실제 setTimeout을 기다리면 백오프 상한(30s)까지 검증하는 데 분 단위가
 * 걸리고, 그런 테스트는 결국 아무도 안 돌린다.
 *
 * 실행: deno test --allow-read 06-applications/admin-retry.test.js
 */

import { assert, assertEquals } from "jsr:@std/assert@1";

const html = Deno.readTextFileSync(
  new URL("./admin.html", import.meta.url),
);

/** 이름으로 함수(또는 var) 본문을 중괄호 균형으로 잘라낸다. */
function extract(name, kind) {
  const head = kind === "var" ? `var ${name}` : `function ${name}(`;
  const i = html.indexOf(head);
  assert(i > 0, `추출 실패: ${name} — admin.html 구조가 바뀌었다. 테스트를 고친다`);
  let depth = 0, k = html.indexOf("{", i);
  for (; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}" && --depth === 0) { k++; break; }
  }
  return html.slice(i, k);
}

const CAM_RETRY_MAX = Number(html.match(/var CAM_RETRY_MAX = (\d+)/)?.[1]);
assert(CAM_RETRY_MAX > 0, "CAM_RETRY_MAX를 못 읽었다");

/** 스텁 환경을 새로 차리고 대상 함수 세 개를 돌려준다. */
function harness() {
  const env = {
    CAM: { players: {}, attached: {}, errors: {}, retries: {}, timers: {} },
    cardExists: true,
    attachCalls: [],
    timers: [],
    clock: 0,
  };

  const setTimeoutStub = (fn, ms) => {
    const t = { fn, at: env.clock + ms, live: true };
    env.timers.push(t);
    return t;
  };
  const clearTimeoutStub = (t) => { if (t) t.live = false; };

  env.advance = (ms) => {
    env.clock += ms;
    env.timers
      .filter((t) => t.live && t.at <= env.clock)
      .sort((a, b) => a.at - b.at)
      .forEach((t) => { t.live = false; t.fn(); });
  };

  // CAM은 admin.html에서 같은 스코프의 var다. new Function은 전역 스코프라 여기로 넘긴다.
  Object.defineProperty(globalThis, "CAM", {
    get: () => env.CAM,
    configurable: true,
  });

  const src = [
    extract("CAM_RETRY_MAX", "var"),
    extract("camRetryDelay"),
    extract("camRetry"),
    extract("reattachLive"),
  ].join("\n");

  const fns = new Function(
    "setTimeout",
    "clearTimeout",
    "document",
    "paintCameraMeta",
    "cameraById",
    "attachLive",
    `${src}; return { camRetryDelay, camRetry, reattachLive };`,
  )(
    setTimeoutStub,
    clearTimeoutStub,
    { querySelector: () => (env.cardExists ? {} : null) },
    () => {},
    (id) => ({ id, name: "stub" }),
    (c) => {
      env.attachCalls.push(c.id);
      env.CAM.attached[c.id] = true;
      env.CAM.players[c.id] = { destroy() {} };
    },
  );

  return { ...fns, env };
}

const CAM_ID = "cam1";
const cam = { id: CAM_ID, name: "라운지 우측" };

Deno.test("백오프가 1s에서 시작해 30s에서 멈춘다", () => {
  const { camRetryDelay } = harness();
  assertEquals(camRetryDelay(0), 1000);
  assertEquals(camRetryDelay(1), 2000);
  assertEquals(camRetryDelay(5), 30000);
  // 상한이 없으면 지수가 커지며 사실상 영영 재시도가 안 온다.
  assertEquals(camRetryDelay(99), 30000);
});

Deno.test("예약한 재시도는 시간이 지나야 실행된다", () => {
  const { camRetry, env } = harness();
  let ran = 0;
  camRetry(cam, () => ran++);
  env.advance(999);
  assertEquals(ran, 0, "1초 전에 실행되면 백오프가 무의미하다");
  env.advance(2);
  assertEquals(ran, 1);
  assertEquals(env.CAM.retries[CAM_ID], 1);
});

Deno.test("등록 해제된 카메라는 되살리지 않는다", () => {
  const { camRetry, env } = harness();
  let ran = 0;
  env.cardExists = false;
  camRetry(cam, () => ran++);
  env.advance(5000);
  assertEquals(ran, 0, "카드가 사라졌는데 되살아나면 유령 스트림이 흐른다");
});

Deno.test("재연결 예약이 중첩되지 않는다", () => {
  const { camRetry, env } = harness();
  let ran = 0;
  camRetry(cam, () => ran++);
  camRetry(cam, () => ran++);
  camRetry(cam, () => ran++);
  env.advance(60000);
  // 겹쳐 실행되면 hls 인스턴스가 여러 개 동시에 스트림을 당긴다 — 이미 버거운 업링크에 치명적이다.
  assertEquals(ran, 1, `동시 실행 ${ran}회 — 직전 타이머를 안 끊었다`);
});

Deno.test(`${CAM_RETRY_MAX}회를 넘으면 포기하고 이유를 남긴다`, () => {
  const { camRetry, env } = harness();
  let ran = 0;
  for (let i = 0; i < CAM_RETRY_MAX; i++) {
    camRetry(cam, () => ran++);
    env.advance(60000);
  }
  assertEquals(ran, CAM_RETRY_MAX);

  camRetry(cam, () => ran++);
  env.advance(60000);
  assertEquals(ran, CAM_RETRY_MAX, "한도를 넘어도 재시도하면 업링크를 계속 태운다");
  // 검은 화면만 남으면 '재연결 중'과 '포기했다'가 구분되지 않는다.
  assert(
    /재연결 실패/.test(env.CAM.errors[CAM_ID] ?? ""),
    "포기했으면 화면에 이유가 있어야 한다",
  );
});

Deno.test("화면이 들어와 카운터가 0이 되면 다시 처음부터 센다", () => {
  const { camRetry, env } = harness();
  let ran = 0;
  for (let i = 0; i < CAM_RETRY_MAX; i++) {
    camRetry(cam, () => ran++);
    env.advance(60000);
  }
  env.CAM.retries[CAM_ID] = 0; // FRAG_BUFFERED 핸들러가 하는 일
  camRetry(cam, () => ran++);
  env.advance(60000);
  // 리셋이 안 먹으면 하루 종일 켜둔 정상 스트림이 6번째 끊김 이후로 영영 안 붙는다.
  assertEquals(ran, CAM_RETRY_MAX + 1, "리셋 뒤에도 포기 상태로 남았다");
});

Deno.test("reattachLive는 옛 인스턴스를 버리고 새로 붙인다", () => {
  const { reattachLive, env } = harness();
  let destroyed = false;
  env.CAM.players[CAM_ID] = { destroy() { destroyed = true; } };
  env.CAM.attached[CAM_ID] = true;

  reattachLive(cam);
  assert(destroyed, "옛 인스턴스를 안 버리면 둘이 같이 스트림을 당긴다");
  assertEquals(env.attachCalls, [CAM_ID]);
});

Deno.test("destroy가 던져도 재부착은 진행된다", () => {
  const { reattachLive, env } = harness();
  env.CAM.players[CAM_ID] = { destroy() { throw new Error("이미 정리됨"); } };

  reattachLive(cam);
  // 정리 실패가 재연결을 막으면 그 카드는 영구 검은 화면이 된다.
  assertEquals(env.attachCalls, [CAM_ID], "정리 실패가 재연결을 막았다");
});
