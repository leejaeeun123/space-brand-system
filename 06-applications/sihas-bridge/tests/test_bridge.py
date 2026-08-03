"""bridge.py 오케스트레이션 — 특히 명령 후 재확인 로직의 회귀 방지.

버그 시나리오: 릴레이가 아직 안 붙었을 때 중간 실측을 그대로 발행하면 옛값이 새
타임스탬프로 나가 UI 토글이 되돌아간 것처럼 보인다. 이 파일은 그 버그가 다시 들어오지
않는지만 고정한다 — 실기기·실 MQTT 연결은 쓰지 않는다.
"""

from unittest.mock import MagicMock

from sihas_bridge.bridge import Bridge, cmnd_topic, lwt_topic, stat_topic
from sihas_bridge.config import BridgeConfig, DeviceConfig

DEVICE = DeviceConfig(address="sihas_ad7a94_ch0", ip="192.168.200.122", mac="a8:2b:d6:ad:7a:94", channel=0)


def _bridge_with_fake_device(poll_sequence):
    """Bridge 를 만들고 내부 SihasDevice/MQTT client 를 목으로 바꿔치기."""
    cfg = BridgeConfig(devices=(DEVICE,), mqtt_host="localhost", mqtt_port=1883, poll_interval_s=30.0)
    bridge = Bridge(cfg)
    fake_dev = MagicMock()
    fake_dev.set_channel.return_value = True
    fake_dev.poll_channel.side_effect = poll_sequence
    topic = cmnd_topic(DEVICE)
    bridge._entries[topic] = (DEVICE, fake_dev)
    bridge._client = MagicMock()
    return bridge, fake_dev


def test_command_verified_immediately_publishes_once():
    """0.5초 뒤 실측이 곧바로 명령값과 일치하면 그 값 1건만 발행한다."""
    bridge, fake_dev = _bridge_with_fake_device(poll_sequence=[True])
    bridge._apply_command(DEVICE, fake_dev, desired=True)
    bridge._client.publish.assert_called_once_with(stat_topic(DEVICE), "ON", qos=1)


def test_mismatched_intermediate_read_is_never_published():
    """릴레이가 안 붙어 첫 실측이 옛값이면, 그 옛값은 발행하지 않고 최종 실측만 낸다.

    회귀 시나리오: 첫 poll=False(옛값), 두 번째 poll=True(desired와 일치) —
    중간의 False 가 stat 로 나가면 UI 가 꺼짐→켜짐으로 깜빡인다. 발행은 정확히
    1건, 그것도 최종 일치값(True)이어야 한다.
    """
    bridge, fake_dev = _bridge_with_fake_device(poll_sequence=[False, True])
    bridge._apply_command(DEVICE, fake_dev, desired=True)
    assert bridge._client.publish.call_count == 1
    bridge._client.publish.assert_called_once_with(stat_topic(DEVICE), "ON", qos=1)


def test_persistent_mismatch_publishes_final_truth_not_desired():
    """2회 재시도 후에도 어긋나면, 요청값이 아니라 마지막 실측값을 그대로 낸다(낙관 금지)."""
    bridge, fake_dev = _bridge_with_fake_device(poll_sequence=[False, False])
    bridge._apply_command(DEVICE, fake_dev, desired=True)
    bridge._client.publish.assert_called_once_with(stat_topic(DEVICE), "OFF", qos=1)


def test_unknown_final_state_is_not_published():
    """재확인 끝까지 통신이 안 되면(None) 추측을 실측인 척 내보내지 않는다 — 발행 자체를 안 한다."""
    bridge, fake_dev = _bridge_with_fake_device(poll_sequence=[None, None])
    bridge._apply_command(DEVICE, fake_dev, desired=True)
    bridge._client.publish.assert_not_called()


def test_query_message_does_not_command_only_polls_and_publishes():
    """cmnd 토픽에 빈 payload 가 오면 커맨드 없이 poll 후 재발행만 한다(전원 불변)."""
    bridge, fake_dev = _bridge_with_fake_device(poll_sequence=[True])
    topic = cmnd_topic(DEVICE)
    msg = MagicMock()
    msg.topic = topic
    msg.payload = b""
    bridge._on_message(bridge._client, None, msg)
    job = bridge._jobs.get_nowait()
    assert job == (topic, "query", None)
    fake_dev.set_channel.assert_not_called()


def test_on_off_payload_queues_set_command():
    bridge, fake_dev = _bridge_with_fake_device(poll_sequence=[])
    topic = cmnd_topic(DEVICE)
    msg = MagicMock()
    msg.topic = topic
    msg.payload = b"ON"
    bridge._on_message(bridge._client, None, msg)
    job = bridge._jobs.get_nowait()
    assert job == (topic, "set", True)


def test_unknown_payload_is_ignored_no_job_queued():
    bridge, fake_dev = _bridge_with_fake_device(poll_sequence=[])
    topic = cmnd_topic(DEVICE)
    msg = MagicMock()
    msg.topic = topic
    msg.payload = b"garbage"
    bridge._on_message(bridge._client, None, msg)
    assert bridge._jobs.empty()


def test_message_on_unmapped_topic_is_ignored():
    bridge, fake_dev = _bridge_with_fake_device(poll_sequence=[])
    msg = MagicMock()
    msg.topic = "cmnd/unknown_device/POWER"
    msg.payload = b"ON"
    bridge._on_message(bridge._client, None, msg)
    assert bridge._jobs.empty()


def test_bridge_topics_helpers_match_expected_contract():
    assert cmnd_topic(DEVICE) == "cmnd/sihas_ad7a94_ch0/POWER"
    assert stat_topic(DEVICE) == "stat/sihas_ad7a94_ch0/POWER"
    assert lwt_topic(DEVICE) == "tele/sihas_ad7a94_ch0/LWT"
