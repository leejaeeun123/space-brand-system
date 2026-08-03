"""기기 1대(1채널) 상위 API — 단일 책임: 채널의 on/off 를 읽고 쓴다.

호출부(bridge)는 여기서부터 아래로 UDP·바이트열을 몰라도 된다.
통신 실패는 예외가 아니라 `None`(모름) 으로 돌려준다 — 브리지 루프가 한 대의 침묵 때문에
죽으면 안 되고, '모름'은 '꺼짐'과 다르게 다뤄야 하기 때문이다.
"""

from __future__ import annotations

import logging

from . import protocol
from .transport import TransportError, UdpTransport

log = logging.getLogger(__name__)


class SihasDevice:
    def __init__(self, ip: str, channel: int, label: str = "", port: int = protocol.PORT):
        self.channel = channel
        self.label = label or ip
        self._transport = UdpTransport(ip, port)
        self._pid = protocol.PID_MIN

    def poll_channel(self) -> bool | None:
        """채널 실측값. 통신 실패나 기기 거부면 None."""
        registers = self._poll_registers()
        if registers is None:
            return None
        if self.channel >= len(registers):
            log.error("[%s] 채널 %d 가 레지스터 범위 밖입니다 — config 의 channel 을 확인하세요",
                      self.label, self.channel)
            return None
        return bool(registers[self.channel])

    def set_channel(self, on: bool) -> bool:
        """켜기/끄기 명령 전송. 반환값은 **전송 성공** 여부일 뿐 반영 여부가 아니다.

        실제 반영은 호출부가 뒤이어 poll_channel() 로 확인한다.
        """
        packet = protocol.build_command_request(self._take_pid(), self.channel, 1 if on else 0)
        try:
            self._transport.send(packet)
            return True
        except OSError as e:
            log.warning("[%s] 명령 전송 실패: %s", self.label, e)
            return False

    def _poll_registers(self) -> list[int] | None:
        packet = protocol.build_poll_request(self._take_pid())
        try:
            return protocol.parse_poll_response(self._transport.request(packet))
        except TransportError as e:
            log.warning("[%s] 응답 없음: %s", self.label, e)
        except protocol.ModbusDisabledError as e:
            log.error("[%s] %s", self.label, e)
        except protocol.ProtocolError as e:
            log.warning("[%s] 응답 해석 실패: %s", self.label, e)
        return None

    def _take_pid(self) -> int:
        pid = self._pid
        self._pid = protocol.next_pid(pid)
        return pid
