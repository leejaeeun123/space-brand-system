"""UDP 소켓 레이어 — 단일 책임: protocol.py 가 만든 바이트열을 기기와 주고받는다.

요청마다 새 소켓을 연다. 상시 소켓을 유지하면 기기 재부팅·NAT 만료 후 조용히 죽은 소켓에
계속 쏘게 되는데, 이 브리지는 30초에 한 번 말을 거는 게 전부라 재사용 이득이 없다.
"""

from __future__ import annotations

import logging
import socket
import time

log = logging.getLogger(__name__)

TIMEOUT_S = 0.5
RETRIES = 3
_BACKOFF_S = 0.15
_RECV_BUF = 512


class TransportError(OSError):
    """재시도를 다 쓰고도 기기에 닿지 못했다."""


class UdpTransport:
    def __init__(self, ip: str, port: int, timeout_s: float = TIMEOUT_S, retries: int = RETRIES):
        self.ip = ip
        self.port = port
        self.timeout_s = timeout_s
        self.retries = retries

    def request(self, packet: bytes) -> bytes:
        """응답을 기다리는 요청(poll). 실패 시 TransportError."""
        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                with self._socket() as sock:
                    sock.sendto(packet, (self.ip, self.port))
                    data, _ = sock.recvfrom(_RECV_BUF)
                    return data
            except OSError as e:
                last = e
                log.debug("[udp] %s:%d 요청 실패 (%d/%d): %s", self.ip, self.port, attempt, self.retries, e)
                if attempt < self.retries:
                    time.sleep(_BACKOFF_S * attempt)
        raise TransportError(f"{self.ip}:{self.port} 응답 없음 ({self.retries}회 시도): {last}")

    def send(self, packet: bytes) -> None:
        """응답을 쓰지 않는 요청(command). 기기가 뭔가 보내면 버린다.

        명령의 성공 여부는 이 응답이 아니라 **뒤이은 poll 실측**으로 판정한다 — 기기가
        ack 를 줘도 릴레이가 실제로 붙었다는 보장이 아니기 때문이다.
        """
        with self._socket() as sock:
            sock.sendto(packet, (self.ip, self.port))
            try:
                sock.recvfrom(_RECV_BUF)
            except OSError:
                pass

    def _socket(self) -> socket.socket:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(self.timeout_s)
        return sock
