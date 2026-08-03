"""UDP↔MQTT 번역기 — 단일 책임: SiHAS 기기를 Tasmota 처럼 보이게 만든다.

이 미들웨어의 존재 이유는 **백엔드가 SiHAS 를 몰라도 되게** 하는 것이다. 그래서 토픽 계약을
Tasmota 와 한 글자도 다르지 않게 흉내 낸다(진실원은 백엔드 `tasmota/topics.ts`):

    cmnd/<address>/POWER   구독  — "ON"/"OFF"=명령, 빈 payload=상태 질의(전원 불변)
    stat/<address>/POWER   발행  — 실측 상태
    tele/<address>/LWT     발행  — "Online"/"Offline", retained

기기는 `devices.adapter = 'tasmota'` 로 그대로 등록한다 — 백엔드 입장에서 SiHAS와 Tasmota는
구분할 이유가 없다(같은 로컬 mosquitto, 같은 토픽 문법, 같은 capabilities=['power']).

UDP 접근은 워커 스레드 하나로 직렬화한다. 기기는 동시 요청을 잘 받지 못하고, 명령 후 실측
확인이 초 단위로 대기하므로 MQTT 네트워크 스레드에서 하면 keepalive 를 막는다.
"""

from __future__ import annotations

import logging
import queue
import threading
import time

import paho.mqtt.client as mqtt

from .config import BridgeConfig, DeviceConfig
from .device import SihasDevice

log = logging.getLogger(__name__)

QOS = 1
_RECONNECT_MIN_S = 1
_RECONNECT_MAX_S = 30
_KEEPALIVE_S = 60

# 명령 후 실측 확인 시점. 릴레이가 붙기 전에 읽으면 **옛값을 새 타임스탬프로** 발행해
# UI 에서 토글이 되돌아간 것처럼 보인다 — 그래서 어긋나면 한 박자 늦게 한 번 더 읽는다.
_VERIFY_DELAYS_S = (0.5, 1.2)


def cmnd_topic(d: DeviceConfig) -> str:
    return f"cmnd/{d.address}/POWER"


def stat_topic(d: DeviceConfig) -> str:
    return f"stat/{d.address}/POWER"


def lwt_topic(d: DeviceConfig) -> str:
    return f"tele/{d.address}/LWT"


def _payload(on: bool) -> str:
    return "ON" if on else "OFF"


class Bridge:
    def __init__(self, cfg: BridgeConfig):
        self._cfg = cfg
        self._entries: dict[str, tuple[DeviceConfig, SihasDevice]] = {
            cmnd_topic(d): (d, SihasDevice(d.ip, d.channel, label=d.address)) for d in cfg.devices
        }
        self._jobs: queue.Queue[tuple[str, str, bool | None]] = queue.Queue()
        self._stop = threading.Event()
        self._client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        if cfg.mqtt_username is not None:
            self._client.username_pw_set(cfg.mqtt_username, cfg.mqtt_password)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message

    def run(self) -> None:
        """블로킹 실행. 연결이 끊기면 paho 가 backoff 로 재접속한다(크래시하지 않음)."""
        self._log_contract()
        first = self._cfg.devices[0]
        self._client.will_set(lwt_topic(first), "Offline", qos=QOS, retain=True)
        if len(self._cfg.devices) > 1:
            log.warning("MQTT will 은 연결당 1개뿐 — 크래시 시 자동 Offline 은 %s 만 적용됩니다",
                        first.address)
        self._client.reconnect_delay_set(min_delay=_RECONNECT_MIN_S, max_delay=_RECONNECT_MAX_S)
        worker = threading.Thread(target=self._worker, name="sihas-worker", daemon=True)
        worker.start()
        try:
            self._client.connect_async(self._cfg.mqtt_host, self._cfg.mqtt_port, _KEEPALIVE_S)
            self._client.loop_forever(retry_first_connection=True)
        finally:
            self._stop.set()
            worker.join(timeout=5)

    def _log_contract(self) -> None:
        """운영자가 DB `devices.address` / `config.json` 의 `address` 와 **문자열 대조**할 수
        있게 실제 쓰는 토픽을 그대로 찍는다. 셋 중 하나만 어긋나도 에러 없이 조용히 실패한다."""
        for d in self._cfg.devices:
            log.info("bridge topics: %s", [cmnd_topic(d), stat_topic(d), lwt_topic(d)])

    # --- MQTT 콜백 (네트워크 스레드) ---------------------------------------

    def _on_connect(self, client, userdata, flags, reason_code, properties=None) -> None:
        if reason_code.is_failure:
            log.error("mosquitto 연결 거부: %s", reason_code)
            return
        log.info("mosquitto 연결됨 %s:%d", self._cfg.mqtt_host, self._cfg.mqtt_port)
        for topic, (d, _) in self._entries.items():
            client.publish(lwt_topic(d), "Online", qos=QOS, retain=True)
            client.subscribe(topic, qos=QOS)
            self._jobs.put((topic, "query", None))

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None) -> None:
        log.warning("mosquitto 연결 끊김 (%s) — 재접속 시도", reason_code)

    def _on_message(self, client, userdata, msg) -> None:
        entry = self._entries.get(msg.topic)
        if entry is None:
            return
        payload = msg.payload.decode(errors="replace").strip()
        if payload == "":                      # 빈 payload = 상태 질의. 전원을 바꾸지 않는다.
            self._jobs.put((msg.topic, "query", None))
        elif payload in ("ON", "OFF"):
            self._jobs.put((msg.topic, "set", payload == "ON"))
        else:
            log.info("[%s] 알 수 없는 payload 무시: %r", entry[0].address, payload)

    # --- 워커 스레드 (UDP 직렬화) -------------------------------------------

    def _worker(self) -> None:
        next_poll = time.monotonic() + self._cfg.poll_interval_s
        while not self._stop.is_set():
            try:
                topic, kind, desired = self._jobs.get(timeout=max(0.0, next_poll - time.monotonic()))
            except queue.Empty:
                self._poll_all()
                next_poll = time.monotonic() + self._cfg.poll_interval_s
                continue
            d, dev = self._entries[topic]
            if kind == "query":
                self._publish_state(d, dev.poll_channel())
            else:
                self._apply_command(d, dev, bool(desired))

    def _poll_all(self) -> None:
        """주기 폴링. 채널 설정 오류나 기기 다운을 스스로 드러내는 안전망이다."""
        for d, dev in self._entries.values():
            self._publish_state(d, dev.poll_channel())

    def _apply_command(self, d: DeviceConfig, dev: SihasDevice, desired: bool) -> None:
        if not dev.set_channel(desired):
            log.warning("[%s] 명령 전송 실패 — 실측만 발행합니다", d.address)
        actual: bool | None = None
        for delay in _VERIFY_DELAYS_S:
            self._stop.wait(delay)
            actual = dev.poll_channel()
            if actual == desired:
                self._publish_state(d, actual)
                return
        # 중간의 어긋난 실측은 발행하지 않는다 — 릴레이가 붙기 전 옛값을 내보내면 UI 토글이
        # 되돌아갔다 다시 켜지는 것처럼 깜빡인다. 마지막 실측만 진실로 내보낸다.
        self._publish_state(d, actual)
        log.warning("[%s] 명령 후 재확인 불일치 (요청=%s 실측=%s) — 채널 설정/기기 상태 확인 필요",
                    d.address, _payload(desired), "모름" if actual is None else _payload(actual))

    def _publish_state(self, d: DeviceConfig, on: bool | None) -> None:
        """모르는 상태(None)는 발행하지 않는다 — 추측을 실측인 척 내보내지 않기 위함."""
        if on is None:
            return
        self._client.publish(stat_topic(d), _payload(on), qos=QOS)
