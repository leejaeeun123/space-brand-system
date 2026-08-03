"""`06-applications/sihas-bridge/` 를 sys.path 에 올려 `sihas_bridge` 를 import 가능하게 한다.

이 패키지는 설치되지 않고 현장 Mac 에 소스 그대로 복사돼 돌아간다 — 그래서 테스트도
설치 없이 실행되어야 한다.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
