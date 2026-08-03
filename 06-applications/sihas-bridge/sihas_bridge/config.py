"""JSON 설정 로더 — 단일 책임: 설정을 읽고 **기동 시점에** 문법을 터뜨린다.

address 검증 규칙은 백엔드 `tasmota/topics.ts` 의 계약을 그대로 재현한다(그 모듈을
import 하지 않는다 — 이 무인 노드는 백엔드 의존성과 완전히 격리한다). 어긋난 주소를
그냥 통과시키면 명령이 **에러 없이 조용히** 사라지므로 여기서 죽는 게 낫다.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

_ADDRESS_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

DEFAULT_MQTT_HOST = "localhost"
DEFAULT_MQTT_PORT = 1883
DEFAULT_POLL_INTERVAL_S = 30.0


class ConfigError(ValueError):
    """설정 파일이 계약을 어겼다."""


@dataclass(frozen=True)
class DeviceConfig:
    address: str
    ip: str
    mac: str
    channel: int


@dataclass(frozen=True)
class BridgeConfig:
    devices: tuple[DeviceConfig, ...]
    mqtt_host: str
    mqtt_port: int
    poll_interval_s: float
    mqtt_username: str | None = None
    mqtt_password: str | None = None


def _device(raw: dict, idx: int) -> DeviceConfig:
    def field(key: str) -> str:
        v = raw.get(key)
        if not isinstance(v, str) or not v.strip():
            raise ConfigError(f"devices[{idx}].{key} 가 비어 있습니다")
        return v.strip()

    address = field("address")
    if not _ADDRESS_RE.match(address):
        raise ConfigError(f"devices[{idx}].address 는 영숫자·_·- 1~32자만 허용합니다: {address!r}")
    channel = raw.get("channel", 0)
    if not isinstance(channel, int) or isinstance(channel, bool) or channel < 0:
        raise ConfigError(f"devices[{idx}].channel 은 0 이상의 정수여야 합니다: {channel!r}")
    return DeviceConfig(address=address, ip=field("ip"), mac=field("mac"), channel=channel)


def load(path: str | Path) -> BridgeConfig:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"설정 파일이 없습니다: {p} (config.example.json 을 복사해 채우세요)")
    raw = json.loads(p.read_text(encoding="utf-8"))
    devices = raw.get("devices")
    if not isinstance(devices, list) or not devices:
        raise ConfigError("devices 배열이 비어 있습니다")
    username = raw.get("mqtt_username")
    password = raw.get("mqtt_password")
    if (username is None) != (password is None):
        raise ConfigError("mqtt_username 과 mqtt_password 는 둘 다 있거나 둘 다 없어야 합니다")
    return BridgeConfig(
        devices=tuple(_device(d, i) for i, d in enumerate(devices)),
        mqtt_host=raw.get("mqtt_host", DEFAULT_MQTT_HOST),
        mqtt_port=int(raw.get("mqtt_port", DEFAULT_MQTT_PORT)),
        poll_interval_s=float(raw.get("poll_interval_s", DEFAULT_POLL_INTERVAL_S)),
        mqtt_username=username,
        mqtt_password=password,
    )
