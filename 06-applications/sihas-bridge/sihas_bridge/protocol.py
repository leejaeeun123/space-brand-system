"""SQM-300 UDP 프레임 조립·해석 — 단일 책임: 바이트열을 만들고 읽는다. 소켓 I/O 없음.

UDP 프로토콜은 github.com/cmsong-shina/sihas-canary (BSD-3-Clause,
Copyright (c) 2021, cmsong-shina)를 참고해 재구현함.

프레임 = 헤더(7바이트) + 데이터(5바이트), 전부 big-endian.

    pid(2) | 0x00 | 0x00 | dlen(2) | checksum(1) | function code(1) | arg1(2) | arg2(2)

  - pid: 1~0xFF 순환 카운터. 응답 짝맞춤용이 아니라 기기가 중복 프레임을 거르는 용도다.
  - dlen: 6 고정.
  - checksum: 앞 6바이트의 합 & 0xFF.
  - poll  → fc=0x03, arg1=start(0), arg2=count(64)
  - write → fc=0x06, arg1=레지스터 인덱스, arg2=값

포트 502를 쓰지만 Modbus 가 아니다 — 이름만 비슷한 커스텀 프로토콜이다.
"""

from __future__ import annotations

import struct

PORT = 502

FC_POLL = 0x03
FC_COMMAND = 0x06

REGISTER_COUNT = 64
RESPONSE_LEN = 137
FUNCTION_CODE_OFFSET = 7
REGISTER_OFFSET = 9

PID_MIN = 1
PID_MAX = 0xFF

_DATA_LEN = 6
# 이 비트가 켜진 채로 응답이 오면 기기의 Modbus(로컬 제어) 설정이 꺼져 있다는 뜻이다.
_DISABLED_BIT = 0x08


class ProtocolError(ValueError):
    """프레임 문법 위반. 잘린 응답·길이 불일치 등."""


class ModbusDisabledError(ProtocolError):
    """기기가 로컬 제어를 거부했다. 재시도로 풀리지 않는다 — 기기 설정을 봐야 한다."""


def next_pid(pid: int) -> int:
    """1~0xFF 순환. 0은 쓰지 않는다."""
    return PID_MIN if pid >= PID_MAX else pid + 1


def _frame(pid: int, function_code: int, arg1: int, arg2: int) -> bytes:
    if not PID_MIN <= pid <= PID_MAX:
        raise ProtocolError(f"pid 범위 밖(1~255): {pid}")
    head = struct.pack(">HBBH", pid, 0x00, 0x00, _DATA_LEN)
    checksum = sum(head) & 0xFF
    return head + bytes([checksum]) + struct.pack(">BHH", function_code, arg1, arg2)


def build_poll_request(pid: int) -> bytes:
    """레지스터 0번부터 64개를 읽는 요청."""
    return _frame(pid, FC_POLL, 0, REGISTER_COUNT)


def build_command_request(pid: int, reg_idx: int, reg_val: int) -> bytes:
    """레지스터 1개 쓰기. 채널 i 를 켜려면 reg_idx=i, reg_val=1 (끄기=0)."""
    if not 0 <= reg_idx < REGISTER_COUNT:
        raise ProtocolError(f"레지스터 인덱스 범위 밖(0~{REGISTER_COUNT - 1}): {reg_idx}")
    if not 0 <= reg_val <= 0xFFFF:
        raise ProtocolError(f"레지스터 값 범위 밖(0~65535): {reg_val}")
    return _frame(pid, FC_COMMAND, reg_idx, reg_val)


def parse_poll_response(data: bytes) -> list[int]:
    """poll 응답 137바이트 → 레지스터 64개. 채널 i 의 on/off 는 registers[i] (1=on)."""
    if len(data) != RESPONSE_LEN:
        raise ProtocolError(f"응답 길이가 {RESPONSE_LEN}바이트가 아닙니다: {len(data)}")
    function_code = data[FUNCTION_CODE_OFFSET]
    if function_code & _DISABLED_BIT:
        raise ModbusDisabledError(f"기기가 로컬 제어 비활성 상태입니다 (fc=0x{function_code:02x})")
    return list(struct.unpack(f">{REGISTER_COUNT}H", data[REGISTER_OFFSET:]))
