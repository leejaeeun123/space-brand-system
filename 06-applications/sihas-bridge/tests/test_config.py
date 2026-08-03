"""config.load() 검증 규칙 — address 문법, mqtt_username/password 페어링."""

import json

import pytest

from sihas_bridge.config import ConfigError, load


def _write(tmp_path, **overrides):
    payload = {
        "devices": [
            {
                "address": "sihas_ad7a94_ch0",
                "ip": "192.168.200.159",
                "mac": "a8:2b:d6:ad:7a:94",
                "channel": 0,
            }
        ],
    }
    payload.update(overrides)
    p = tmp_path / "config.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    return p


def test_valid_config_loads(tmp_path):
    cfg = load(_write(tmp_path))
    assert cfg.devices[0].address == "sihas_ad7a94_ch0"
    assert cfg.mqtt_username is None
    assert cfg.mqtt_password is None


def test_wildcard_address_rejected(tmp_path):
    payload = {
        "devices": [
            {"address": "sihas/+", "ip": "1.2.3.4", "mac": "aa:bb", "channel": 0}
        ]
    }
    p = tmp_path / "config.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ConfigError, match="address"):
        load(p)


def test_mqtt_username_without_password_rejected(tmp_path):
    p = _write(tmp_path, mqtt_username="bridge")
    with pytest.raises(ConfigError, match="mqtt_username"):
        load(p)


def test_mqtt_password_without_username_rejected(tmp_path):
    p = _write(tmp_path, mqtt_password="secret")
    with pytest.raises(ConfigError, match="mqtt_username"):
        load(p)


def test_mqtt_username_and_password_together_ok(tmp_path):
    cfg = load(_write(tmp_path, mqtt_username="bridge", mqtt_password="secret"))
    assert cfg.mqtt_username == "bridge"
    assert cfg.mqtt_password == "secret"


def test_missing_config_file_rejected(tmp_path):
    with pytest.raises(ConfigError, match="설정 파일이 없습니다"):
        load(tmp_path / "does-not-exist.json")


def test_empty_devices_array_rejected(tmp_path):
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"devices": []}), encoding="utf-8")
    with pytest.raises(ConfigError, match="devices"):
        load(p)
