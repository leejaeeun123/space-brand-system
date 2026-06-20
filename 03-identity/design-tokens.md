# Phase 3 — 디자인 토큰

> 단일 진실 공급원(SSOT). 컬러는 **디지털(RGB/HEX) + 물리(CMYK/Pantone·소재)** 이원 스키마.
> 물리 값은 근사 — 인쇄·사이니지 발주 전 실물 스와치 확인 필수.

## 1. 컬러 토큰 (이원 스키마)

| 토큰 | HEX | RGB | CMYK (근사) | Pantone (근사) | 소재(물리) |
|---|---|---|---|---|---|
| `color/base/oat` | #F2EBDD | 242,235,221 | 5·7·16·0 | 9224 C | — (배경) |
| `color/wood/honey-oak` | #C49A6C | 196,154,108 | 25·40·62·2 | 7569 C | 오크/자작 원목 |
| `color/accent/cognac` | #8A553A | 138,85,58 | 38·68·80·33 | 1685 C | 가죽 |
| `color/ink/black` | #1B1A17 | 27,26,23 | 67·62·68·72 | Black 6 C | 블랙 도장 스틸 |
| `color/metal/chrome` | #AEB2B5 | 174,178,181 | 33·25·24·3 | 877 C(메탈릭) | 헤어라인 스테인리스 |
| `color/neutral/greige` | #B8AE9E | 184,174,158 | 28·29·38·5 | Warm Gray 4 C | 린넨/패브릭 |
| `color/glow/paper` | #E8D9B5 | 232,217,181 | 10·13·32·0 | 7501 C | 한지/아크릴 확산판 |

## 2. 타이포 토큰

| 토큰 | 폰트 (국문 / 영문) | 크기/행간 |
|---|---|---|
| `font/display/xl` | Maru Buri / Fraunces SemiBold | 40/1.2 |
| `font/display/lg` | Maru Buri / Fraunces SemiBold | 32/1.25 |
| `font/heading/md` | Pretendard / Inter SemiBold | 24/1.3 |
| `font/body/lg` | Pretendard / Inter Regular | 18/1.6 |
| `font/body/md` | Pretendard / Inter Regular | 16/1.6 |
| `font/label/md` | Pretendard / Inter Medium | 14/1.4 |
| `font/mode/tag` | Fraunces / Inter Medium, +0.08em, UPPERCASE | 14/1.4 |

## 3. 스페이싱 토큰 (8px 베이스)

| 토큰 | 값 |
|---|---|
| `space/xs` | 4px |
| `space/sm` | 8px |
| `space/md` | 16px |
| `space/lg` | 24px |
| `space/xl` | 40px |
| `space/2xl` | 64px |

## 4. 라디우스 / 라인

| 토큰 | 값 | 비고 |
|---|---|---|
| `radius/sm` | 2px | 미드센추리 — 거의 직각, 약한 라운드만 |
| `radius/md` | 6px | 카드 |
| `radius/pill` | 999px | 모드 태그 칩 |
| `line/hairline` | 1px ink/black @ 40% | 구분선 (절제) |
| `pattern/reeded` | 세로선 반복, 간격 6px | 리드드 글라스 디바이스 |

## 5. 그림자 / 모션 (절제)

| 토큰 | 값 |
|---|---|
| `shadow/soft` | 0 2px 12px rgba(27,26,23,0.08) — 확산광 느낌, 진한 그림자 금지 |
| `motion/fast` | 120ms ease-out (탭·토글) |
| `motion/base` | 240ms cubic-bezier(0.16,1,0.3,1) (패널·시트) |

> `prefers-reduced-motion` 존중. 장식적 모션 금지(V2 절제).

## 6. 소비처

- **디지털**: 예약 웹/랜딩, 인스타 템플릿 → HEX/RGB·폰트·스페이싱 토큰
- **물리**: 사이니지·인쇄물(Phase 4) → CMYK/Pantone·소재 토큰
- 두 소비처가 같은 토큰명을 공유하되 값 컬럼만 달리 참조.
