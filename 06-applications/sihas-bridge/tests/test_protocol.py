"""프레임 바이트 단위 검증. 실기기 없이 프로토콜 계약을 고정한다.

체크섬이나 오프셋이 한 칸 어긋나면 기기는 **에러 없이 침묵**한다 — 그래서 기대 바이트열을
손으로 적어 하드코딩한다. 구현이 스스로를 증명하게 두지 않는다.
"""

import struct

import pytest

from sihas_bridge import protocol


def _response(registers: dict[int, int], function_code: int = protocol.FC_POLL) -> bytes:
    """가짜 poll 응답 137바이트. registers 에 준 인덱스만 값을 심는다."""
    regs = [0] * protocol.REGISTER_COUNT
    for idx, val in registers.items():
        regs[idx] = val
    body = struct.pack(f">{protocol.REGISTER_COUNT}H", *regs)
    return bytes(7) + bytes([function_code, 0x80]) + body


def test_poll_request_bytes():
    # pid=1 → 헤더 00 01 00 00 00 06, 합=7 → 체크섬 07. 데이터 = 03 (start=0) (count=64)
    assert protocol.build_poll_request(1) == bytes.fromhex("000100000006070300000040")


def test_command_request_bytes_on():
    # pid=2 → 헤더 합=8 → 체크섬 08. 데이터 = 06 (reg_idx=0) (reg_val=1)
    assert protocol.build_command_request(2, 0, 1) == bytes.fromhex("000200000006080600000001")


def test_command_request_bytes_off_other_channel():
    # pid=255 → 헤더 00 FF 00 00 00 06, 합=0x105 → 체크섬 05. reg_idx=3, reg_val=0
    expected = bytes.fromhex("00ff00000006050600030000")
    assert protocol.build_command_request(255, 3, 0) == expected


def test_frame_length_is_12_bytes():
    assert len(protocol.build_poll_request(1)) == 12
    assert len(protocol.build_command_request(1, 0, 1)) == 12


def test_checksum_covers_first_six_bytes():
    packet = protocol.build_command_request(200, 5, 1)
    assert packet[6] == sum(packet[:6]) & 0xFF


def test_pid_out_of_range_rejected():
    with pytest.raises(protocol.ProtocolError):
        protocol.build_poll_request(0)
    with pytest.raises(protocol.ProtocolError):
        protocol.build_poll_request(256)


def test_register_index_out_of_range_rejected():
    with pytest.raises(protocol.ProtocolError):
        protocol.build_command_request(1, protocol.REGISTER_COUNT, 1)


def test_next_pid_wraps_to_one():
    assert protocol.next_pid(1) == 2
    assert protocol.next_pid(254) == 255
    assert protocol.next_pid(255) == 1


def test_parse_poll_response_reads_registers():
    registers = protocol.parse_poll_response(_response({0: 1, 3: 1, 63: 7}))
    assert len(registers) == protocol.REGISTER_COUNT
    assert registers[0] == 1
    assert registers[1] == 0
    assert registers[3] == 1
    assert registers[63] == 7


def test_parse_poll_response_reads_big_endian_u16():
    registers = protocol.parse_poll_response(_response({2: 0x0102}))
    assert registers[2] == 0x0102


def test_response_fixture_is_137_bytes():
    assert len(_response({})) == protocol.RESPONSE_LEN


def test_disabled_bit_in_function_code_is_an_error():
    with pytest.raises(protocol.ModbusDisabledError):
        protocol.parse_poll_response(_response({0: 1}, function_code=protocol.FC_POLL | 0x08))


def test_truncated_response_rejected():
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_poll_response(_response({})[:-1])
