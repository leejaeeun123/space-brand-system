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
 * 초록으로 남는 게 제일 나쁘다. handleCamFatal·camMarkAlive를 굳이 이름 있는 함수로
 * 뽑아둔 것도 이 파일 때문이다. 핸들러 안에 인라인으로 두면 실제 hls 인스턴스 없이는
 * 분기를 확인할 방법이 없다.
 *
 * 시계도 스텁이다. 실제 setTimeout을 기다리면 백오프 상한(30s)까지 검증하는 데 분 단위가
 * 걸리고, 그런 테스트는 결국 아무도 안 돌린다.
 *
 * 실행: deno test --allow-read 06-applications/admin-retry.test.js
 */

import { assert, assertEquals } from "jsr:@std/assert@1";

const html = Deno.readTextFileSync(new URL("./admin.html", import.meta.url));

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
const CAM_STABLE_MS = Number(html.match(/var CAM_STABLE_MS = (\d+)/)?.[1]);
assert(CAM_RETRY_MAX > 0, "CAM_RETRY_MAX를 못 읽었다");
assert(CAM_STABLE_MS > 0, "CAM_STABLE_MS를 못 읽었다");

/** hls.js가 실제로 노출하는 상수들(v1). 이름이 틀리면 분기가 통째로 안 걸린다. */
const Hls = {
  ErrorTypes: { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError", OTHER_ERROR: "otherError" },
  ErrorDetails: {
    MANIFEST_LOAD_ERROR: "manifestLoadError",
    MANIFEST_LOAD_TIMEOUT: "manifestLoadTimeOut",
    MANIFEST_PARSING_ERROR: "manifestParsingError",
    FRAG_LOAD_ERROR: "fragLoadError",
    BUFFER_STALLED_ERROR: "bufferStalledError",
  },
};

/** 스텁 환경을 새로 차리고 대상 함수들을 돌려준다. */
function harness() {
  const env = {
    CAM: { players: {}, attached: {}, errors: {}, retries: {}, lastFail: {}, timers: {} },
    cardExists: true,
    attachCalls: [],
    timers: [],
    clock: 0,
    // 가짜 hls 인스턴스가 무엇을 불렸는지 기록한다.
    calls: { startLoad: 0, recoverMediaError: 0, destroy: 0 },
  };

  env.hls = {
    startLoad: () => env.calls.startLoad++,
    recoverMediaError: () => env.calls.recoverMediaError++,
    destroy: () => env.calls.destroy++,
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
  Object.defineProperty(globalThis, "CAM", { get: () => env.CAM, configurable: true });

  const src = [
    extract("CAM_RETRY_MAX", "var"),
    extract("CAM_STABLE_MS", "var"),
    extract("camRetryDelay"),
    extract("camMarkAlive"),
    extract("camRetry"),
    extract("reattachLive"),
    extract("handleCamFatal"),
  ].join("\n");

  const fns = new Function(
    "setTimeout", "clearTimeout", "document", "Hls",
    "paintCameraMeta", "cameraById", "attachLive",
    `${src}; return { camRetryDelay, camMarkAlive, camRetry, reattachLive, handleCamFatal };`,
  )(
    setTimeoutStub, clearTimeoutStub,
    { querySelector: () => (env.cardExists ? {} : null) },
    Hls,
    () => {},
    (id) => ({ id, name: "stub" }),
    (c) => {
      env.attachCalls.push(c.id);
      env.CAM.attached[c.id] = true;
      env.CAM.players[c.id] = env.hls;
    },
  );

  return { ...fns, env };
}

const CAM_ID = "cam1";
const cam = { id: CAM_ID, name: "라운지 우측" };

/** fatal 한 번을 흘려보내고 예약된 재시도까지 실행한다. */
function fireFatal(h, type, details) {
  h.handleCamFatal(cam, h.env.hls, { fatal: true, type, details });
  h.env.advance(60000);
}

// ── 백오프·회계 ────────────────────────────────────────────────────────────

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

// ── 한도 소진 후 (자동 복구 경로가 남아야 한다) ─────────────────────────────

Deno.test(`${CAM_RETRY_MAX}회를 넘으면 빠른 재시도를 멈추고 이유를 남긴다`, () => {
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
  assert(/실패/.test(env.CAM.errors[CAM_ID] ?? ""), "포기했으면 화면에 이유가 있어야 한다");
});

Deno.test("한도 소진 시 부착 표시를 지워 15초 목록 갱신이 다시 붙일 수 있게 한다", () => {
  const { camRetry, env } = harness();
  env.CAM.players[CAM_ID] = env.hls;
  env.CAM.attached[CAM_ID] = true;
  for (let i = 0; i <= CAM_RETRY_MAX; i++) {
    camRetry(cam, () => {});
    env.advance(60000);
  }
  // attached가 true로 남으면 renderCameras가 걸러내 영영 안 붙는다 — 이 커밋이 없애려던 상태다.
  assertEquals(env.CAM.attached[CAM_ID], undefined, "attached가 남아 자동 복구 경로가 끊겼다");
  assertEquals(env.CAM.players[CAM_ID], undefined, "죽은 인스턴스를 안 버렸다");
  assert(env.calls.destroy > 0, "포기하면서 인스턴스를 정리하지 않았다");
});

// ── '살아났다' 판정 ────────────────────────────────────────────────────────

Deno.test("조각 하나로는 백오프가 리셋되지 않는다 (플래핑 방어)", () => {
  const { camMarkAlive, env } = harness();
  env.CAM.retries[CAM_ID] = 4;
  env.CAM.lastFail[CAM_ID] = Date.now(); // 방금 실패했다
  camMarkAlive(cam);
  // 매번 리셋되면 백오프가 1초에 고정되고 한도에도 영영 안 닿는다.
  assertEquals(env.CAM.retries[CAM_ID], 4, "방금 실패했는데 살아난 것으로 쳤다");
});

Deno.test("충분히 이어지면 백오프가 리셋된다", () => {
  const { camMarkAlive, env } = harness();
  env.CAM.retries[CAM_ID] = 4;
  env.CAM.lastFail[CAM_ID] = Date.now() - (CAM_STABLE_MS + 1000);
  camMarkAlive(cam);
  assertEquals(env.CAM.retries[CAM_ID], 0, "안정됐는데도 백오프가 안 풀렸다");
});

Deno.test("한 번도 실패한 적 없으면 리셋된 상태다", () => {
  const { camMarkAlive, env } = harness();
  env.CAM.retries[CAM_ID] = 3;
  camMarkAlive(cam); // lastFail 없음
  assertEquals(env.CAM.retries[CAM_ID], 0);
});

// ── fatal 분기 ─────────────────────────────────────────────────────────────

Deno.test("매니페스트 실패는 startLoad가 아니라 재부착으로 간다", () => {
  for (const details of [
    Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
    Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
    Hls.ErrorDetails.MANIFEST_PARSING_ERROR,
  ]) {
    const h = harness();
    fireFatal(h, Hls.ErrorTypes.NETWORK_ERROR, details);
    /* hls.js에서 MANIFEST_LOADING을 트리거하는 건 loadSource 하나뿐이라 startLoad는
       이 부류에 no-op이다. 여기로 보내면 터널이 내려간 사이 60초를 헛돌고 포기한다. */
    assertEquals(h.env.calls.startLoad, 0, `${details}를 startLoad로 보냈다 — no-op이다`);
    assertEquals(h.env.attachCalls, [CAM_ID], `${details}가 재부착되지 않았다`);
  }
});

Deno.test("일반 네트워크 오류는 같은 인스턴스의 startLoad로 되살린다", () => {
  const h = harness();
  fireFatal(h, Hls.ErrorTypes.NETWORK_ERROR, Hls.ErrorDetails.FRAG_LOAD_ERROR);
  assertEquals(h.env.calls.startLoad, 1);
  // 재부착은 인스턴스를 새로 만드는 값비싼 수단이라 여기서 쓰면 안 된다.
  assertEquals(h.env.attachCalls, [], "싼 수단으로 될 걸 재부착했다");
});

Deno.test("미디어 오류도 백오프와 한도를 거친다", () => {
  const h = harness();
  h.handleCamFatal(cam, h.env.hls, {
    fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR,
  });
  // 예전엔 camRetry를 건너뛰어 지연 0으로 무한 반복했다 — 즉시 불리면 안 된다.
  assertEquals(h.env.calls.recoverMediaError, 0, "지연 없이 즉시 복구를 시도했다");
  assertEquals(h.env.CAM.retries[CAM_ID], 1, "회계를 안 태웠다 — 한도에 영영 안 닿는다");
  h.env.advance(60000);
  assertEquals(h.env.calls.recoverMediaError, 1);
});

Deno.test("미디어 오류가 계속되면 결국 포기하고 이유를 남긴다", () => {
  const h = harness();
  for (let i = 0; i <= CAM_RETRY_MAX; i++) {
    fireFatal(h, Hls.ErrorTypes.MEDIA_ERROR, Hls.ErrorDetails.BUFFER_STALLED_ERROR);
  }
  assertEquals(h.env.calls.recoverMediaError, CAM_RETRY_MAX, "한도를 넘어서도 계속 시도했다");
  assert(/실패/.test(h.env.CAM.errors[CAM_ID] ?? ""), "사용자가 이유를 볼 수 없다");
});

Deno.test("분류되지 않은 fatal은 재부착으로 간다", () => {
  const h = harness();
  fireFatal(h, Hls.ErrorTypes.OTHER_ERROR, "internalException");
  assertEquals(h.env.attachCalls, [CAM_ID]);
});

Deno.test("fatal은 마지막 실패 시각과 화면 문구를 남긴다", () => {
  const h = harness();
  h.handleCamFatal(cam, h.env.hls, {
    fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR, details: Hls.ErrorDetails.FRAG_LOAD_ERROR,
  });
  assert(h.env.CAM.lastFail[CAM_ID] > 0, "lastFail이 없으면 '살아났나' 판정이 무너진다");
  assert(
    /fragLoadError/.test(h.env.CAM.errors[CAM_ID] ?? ""),
    "어느 계층이 죽었는지 화면에 남아야 원인을 좁힐 수 있다",
  );
});

// ── 재부착 ─────────────────────────────────────────────────────────────────

Deno.test("reattachLive는 옛 인스턴스를 버리고 새로 붙인다", () => {
  const { reattachLive, env } = harness();
  env.CAM.players[CAM_ID] = env.hls;
  env.CAM.attached[CAM_ID] = true;

  reattachLive(cam);
  assert(env.calls.destroy > 0, "옛 인스턴스를 안 버리면 둘이 같이 스트림을 당긴다");
  assertEquals(env.attachCalls, [CAM_ID]);
});

Deno.test("destroy가 던져도 재부착은 진행된다", () => {
  const { reattachLive, env } = harness();
  env.CAM.players[CAM_ID] = { destroy() { throw new Error("이미 정리됨"); } };

  reattachLive(cam);
  // 정리 실패가 재연결을 막으면 그 카드는 영구 검은 화면이 된다.
  assertEquals(env.attachCalls, [CAM_ID], "정리 실패가 재연결을 막았다");
});
