"""엔트리포인트 — `python -m sihas_bridge [config.json]`. 이 폴더(06-applications/sihas-bridge/)에서 실행한다."""

from __future__ import annotations

import argparse
import logging
import sys

from .bridge import Bridge
from .config import ConfigError, load

DEFAULT_CONFIG = "config.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sihas_bridge", description="SiHAS SQM-300 UDP↔MQTT 브리지")
    parser.add_argument("config", nargs="?", default=DEFAULT_CONFIG, help="설정 파일 경로")
    parser.add_argument("-v", "--verbose", action="store_true", help="디버그 로그")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        cfg = load(args.config)
    except (ConfigError, ValueError) as e:
        logging.error("설정 오류: %s", e)
        return 2
    try:
        Bridge(cfg).run()
    except KeyboardInterrupt:
        logging.info("종료")
    return 0


if __name__ == "__main__":
    sys.exit(main())
