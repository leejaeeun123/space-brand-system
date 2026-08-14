/**
 * 명령 배달 경로 판정 — 단일 책임: MQTT로 갈지 HTTP로 우회할지 정하고, 도착을 확인한다.
 *
 * ── 왜 이게 따로 필요한가 ───────────────────────────────────────────────────────
 * 예전에는 로컬 브로커 발행이 성공하면 곧바로 `sent`로 기록했다. 로컬 브로커는 맥이 켜져
 * 있는 한 항상 성공하므로 이 기록은 **거의 언제나 참**이었고, 그래서 아무것도 말해주지
 * 않았다. 정작 기기까지 가는 구간(rpi-bridge)은 `cmnd/# out`이 QoS 0이라 브릿지가 죽어
 * 있으면 메시지가 큐에 쌓이지도 않고 사라진다. 결과: 조명은 그대로인데 화면은 '보냄'.
 * `pending`으로 남지 않으니 재시도(drainPending)도 영원히 안 걸렸다.
 *
 * 그래서 둘로 나눠 본다 — 발행할 곳이 있느냐, 발행한 게 닿았느냐.
 */

/**
 * 배달 경로 판정. **부수효과가 없다** — 입력만으로 결정된다.
 *
 * - Tier 1 `!localConnected`: 로컬 브로커부터 없다. 발행할 곳 자체가 없으니 바로 HTTP.
 * - Tier 2 그 외 전부: 일단 한 번 발행하고(`publish`) 기기의 `stat` 보고를 기다린다.
 *   확인되면 끝(`done`), 시간 안에 안 오면 그때 HTTP.
 *
 * ── 왜 브릿지 상태를 안 보는가 (예전엔 봤다) ─────────────────────────────────────
 * 한때 `bridgeUp === false`면 발행을 건너뛰고 바로 HTTP로 가는 가지가 따로 있었다.
 * rpi-bridge의 `cmnd/# out`이 QoS 0이라 브릿지가 죽어 있으면 유실이 **확정**이었고,
 * 확정된 유실을 4초 기다리는 건 낭비였기 때문이다.
 *
 * 그 전제가 깨졌다. 지금은 mosquitto가 같은 `cmnd/#`를 AWS IoT Core로도 **항상 병렬로**
 * 내보내고(mosquitto.conf의 aws-iot-cmnd-bridge), Pi는 자체 브릿지로 그걸 직접 받는다.
 * rpi-bridge가 죽어도 명령은 tailscale과 무관한 경로로 기기까지 간다. 그러니 '브릿지가
 * 죽었다'는 더 이상 '유실 확정'이 아니다 — 그 상태에서 HTTP로 직행하면 AWS로 나간 사본이
 * 도착할 기회를 뺏고, 병렬 경로를 만든 이유를 스스로 없앤다.
 *
 * 발행이 여러 경로로 퍼지는 것은 브로커의 일이고, 이 함수가 알 필요가 없다. 여기서는
 * "한 번 내보내고 기기가 답하는지 본다"만 남는다. 어느 경로로 닿았는지는 묻지 않는다 —
 * 우리가 아는 유일한 증거는 기기가 스스로 보고한 `stat`이고, 그건 경로를 안 가린다.
 *
 * Tier 1을 남겨둔 이유: 로컬 브로커가 없다는 건 종류가 다른 고장이다. 브릿지가 몇 개든
 * 로컬에 발행이 안 되면 어느 브릿지도 실어 나를 게 없어서, 기다림에 그물이 될 여지가 아예
 * 없다. 그때만 기다리지 않고 바로 우회한다.
 *
 * @param {{localConnected: boolean, confirmed?: boolean|null}} inputs
 *   `confirmed`: 발행 전에는 `null`(아직 모름), 확인 대기 후에는 `true`/`false`.
 * @returns {{tier: 1|2, action: "http"|"publish"|"done", reason: string}}
 */
export function decideDelivery({ localConnected, confirmed = null }) {
  if (!localConnected) {
    return { tier: 1, action: "http", reason: "로컬 브로커 연결 없음" };
  }
  if (confirmed === null) {
    return { tier: 2, action: "publish", reason: "발행 후 확인 대기" };
  }
  return confirmed
    ? { tier: 2, action: "done", reason: "기기 보고로 확인됨" }
    : { tier: 2, action: "http", reason: "확인 응답 없음 — 도달 여부 불명" };
}

/**
 * `cmnd/<address>/<suffix>` + payload → HTTP로도 보낼 수 있는 형태.
 * 우리 문법이 아니면 null(그런 명령은 우회할 방법이 없다).
 */
export function parseCommandTopic(topic, payload) {
  const parts = String(topic || "").split("/");
  if (parts.length < 3 || parts[0] !== "cmnd") return null;
  const [, address, ...rest] = parts;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(address)) return null;
  const suffix = rest.join(" ");
  const value = String(payload ?? "").trim();
  return {
    address,
    // Tasmota의 `/cm?cmnd=` 는 MQTT와 같은 문법을 쓴다: `POWER ON`.
    cmnd: value ? `${suffix} ${value}` : suffix,
    // TOGGLE처럼 결과를 미리 모르는 명령은 null — '전원 보고가 오기만 하면 확인'으로 본다.
    //
    // ⚠️ **이 null 가지는 지금 아무도 안 밟는다.** Edge Function(handlers/command.ts)이
    // 넣는 값은 `POWER ON` / `POWER OFF` 둘뿐이라, 확인은 항상 값이 일치해야 성립한다.
    // 나중에 TOGGLE을 실제로 쓰게 되면 이 가지가 문제가 된다 — 5분마다 도는
    // queryInitialState의 빈 POWER 질의에 대한 응답까지 '확인'으로 세기 때문이다.
    // 그건 명령이 도착했다는 증거가 아니다. 그때는 확인 기준을 따로 만들어야 한다.
    expectPower: value === "ON" || value === "OFF" ? value : null,
  };
}

/** address → 확인을 기다리는 것들. 보통 비어 있고, 있어도 기기 수를 넘지 않는다. */
const waiters = new Map();

/**
 * address → 그 주소로 들어온 가장 최신 명령의 requested_at(ms).
 *
 * **왜 필요한가**: OFF 다음 ON을 빠르게 누르면 둘 다 확인 대기(Tier 2)에 걸린다. OFF의
 * `stat` 응답만 유실되면(브릿지 QoS 0이라 흔하다) ON은 확인되고 OFF만 4초 뒤 타임아웃돼
 * HTTP로 우회 전송된다 — 방금 켠 조명을 사용자의 최신 의도와 반대로 다시 꺼버린다.
 * 이 표는 "그 주소로 이것보다 늦게 들어온 명령이 있으면 나는 이제 실행하면 안 된다"를
 * 판정하는 데 쓴다.
 */
const latestRequestedAt = new Map();

/** 이 명령을 그 주소의 "지금까지 본 것 중 가장 최신"으로 기록한다. 순서가 뒤바뀌어 와도
 * 안전하도록 더 최신인 경우에만 갱신한다. */
export function markLatestCommand(address, requestedAtMs) {
  const prev = latestRequestedAt.get(address) ?? 0;
  if (requestedAtMs > prev) latestRequestedAt.set(address, requestedAtMs);
}

/** 이 명령보다 그 주소에 더 최신 명령이 이미 들어왔는가 — HTTP 우회 직전에만 쓴다. */
export function isSuperseded(address, requestedAtMs) {
  return requestedAtMs < (latestRequestedAt.get(address) ?? 0);
}

/**
 * 기기가 전원을 보고했다고 알린다. 기다리던 명령이 있으면 확인 처리한다.
 *
 * ⚠️ **`power === null`인 보고로는 확인하지 않는다.** LWT나 STATUS5는 전원을 모르는
 * 메시지인데, 재접속마다 STATUS5가 오므로 이걸 확인으로 세면 기기에 닿지도 않은 명령이
 * '확인됨'이 된다 — 고치려던 거짓 `sent`를 이름만 바꿔 되살리는 셈이다.
 */
export function noteDeviceReport(address, power) {
  if (power !== "ON" && power !== "OFF") return;
  const list = waiters.get(address);
  if (!list) return;
  for (const w of [...list]) {
    if (w.expectPower === null || w.expectPower === power) w.settle(true);
  }
}

/**
 * 기기의 전원 보고를 `timeoutMs`까지 기다린다. 왔으면 true, 못 받았으면 false.
 * **던지지 않는다** — 못 받은 것도 정상적인 결과이고, 호출부는 그걸 보고 우회한다.
 */
export function awaitConfirmation(address, expectPower, timeoutMs) {
  return new Promise((resolve) => {
    const list = waiters.get(address) ?? [];
    const entry = {
      expectPower,
      settle(ok) {
        clearTimeout(entry.timer);
        const cur = waiters.get(address) ?? [];
        const next = cur.filter((x) => x !== entry);
        if (next.length) waiters.set(address, next);
        else waiters.delete(address);
        resolve(ok);
      },
    };
    // **unref하지 않는다.** 그러면 이 타이머가 이벤트 루프를 붙들지 못해서, 다른 할 일이
    // 없는 순간에는 타임아웃이 영영 안 오고 명령이 `sent`도 `failed`도 아닌 채로 매달린다.
    // 종료가 막힐 걱정은 없다 — 최대 4초고, shutdown()이 어차피 process.exit로 끝낸다.
    entry.timer = setTimeout(() => entry.settle(false), timeoutMs);
    waiters.set(address, [...list, entry]);
  });
}
