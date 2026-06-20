# Phase 3 — 디자인 토큰 (v2, MCM 그래픽)

> 단일 진실 공급원(SSOT). 컬러는 **디지털(RGB/HEX) + 물리(CMYK/Pantone·소재)** 이원 스키마.
> 물리 값은 근사 — 인쇄·사이니지 발주 전 실물 스와치 확인 필수.

## 1. 컬러 토큰 (이원 스키마)

| 토큰 | HEX | RGB | CMYK (근사) | Pantone (근사) | 소재(물리) |
|---|---|---|---|---|---|
| `color/spine/orange` | #E2531E | 226,83,30 | 3·80·95·0 | 1655 C | 컬러 도장(스틸/아크릴) |
| `color/spine/cream` | #F4E9C8 | 244,233,200 | 5·7·24·0 | 7499 C | 크림 도장/아크릴 |
| `color/spine/ink` | #16130F | 22,19,15 | 70·68·72·85 | Black 6 C | 블랙 도장 스틸 |
| `color/block/green` | #235C42 | 35,92,66 | 78·40·76·30 | 7727 C | 컬러 도장 |
| `color/block/cobalt` | #1B4FA0 | 27,79,160 | 92·70·6·0 | 2132 C | 컬러 도장 |
| `color/material/brass` | #B0883C | 176,136,60 | 28·44·90·8 | 7555 C / 871 C(메탈릭) | 브러시드 브라스(놋쇠) |
| `color/material/walnut` | #8A5A33 | 138,90,51 | 35·63·85·25 | 7567 C | 월넛/오크 우드 |
| `color/point/red` | #D8352A | 216,53,42 | 8·90·88·1 | 1788 C | 포인트(소량) |

## 2. 타이포 토큰

| 토큰 | 폰트 (영문 / 국문) | 크기/행간 |
|---|---|---|
| `font/display/2xl` | League Spartan Black / G마켓산스·Pretendard Black | 56/1.0 |
| `font/display/xl` | League Spartan Black / Pretendard Black | 40/1.05 |
| `font/display/lg` | League Spartan Bold / Pretendard Bold | 28/1.1 |
| `font/heading/md` | Inter SemiBold / Pretendard SemiBold | 22/1.3 |
| `font/body/lg` | Inter Regular / Pretendard Regular | 18/1.6 |
| `font/body/md` | Inter Regular / Pretendard Regular | 16/1.6 |
| `font/label/md` | Inter Medium / Pretendard Medium · UPPERCASE | 14/1.4 |
| `font/accent` | Fraunces Italic (강조 1곳만) | 가변 |

## 3. 스페이싱 토큰 (8px 베이스)

| 토큰 | 값 |
|---|---|
| `space/xs` | 4px |
| `space/sm` | 8px |
| `space/md` | 16px |
| `space/lg` | 24px |
| `space/xl` | 40px |
| `space/2xl` | 64px |

## 4. 형태 / 그래픽 디바이스

| 토큰 | 값 | 비고 |
|---|---|---|
| `radius/sm` | 2px | 기하 — 거의 직각 |
| `radius/md` | 8px | 카드 |
| `radius/circle` | 50% | 'O' 모티프·태양 |
| `shape/blob` | 유기적 블롭(솔 바스·노구치풍) | 색면 분할·컷아웃 |
| `ornament/geo` | 태양·원·반복 도형 | 절제 사용(포인트) |

## 5. 모션 (절제)

| 토큰 | 값 |
|---|---|
| `motion/fast` | 120ms ease-out (탭·토글) |
| `motion/base` | 240ms cubic-bezier(0.16,1,0.3,1) (패널) |

> `prefers-reduced-motion` 존중. 장식 모션 금지.

## 6. 소비처 & 레이어

- **디지털·마케팅**: HEX/RGB, 컬러블록 과감 + 기하 산세 디스플레이.
- **공간 사이니지(물리)**: CMYK/Pantone·소재 토큰, 우드·브라스·블랙 물성 중심(차분).
