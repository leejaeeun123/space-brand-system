# space-brand-system

공간 대여 사업의 **브랜딩 & 디자인 시스템**. 브랜드 네이밍 · 컨셉 · 로고 방향 · 사이니지를 마크다운으로 문서화합니다.

## 현재 상태

🟢 **1차 산출물 작성 완료 — 사용자 검토 대기**

- 사업: 합정역 앞 3층(52.49㎡, **층고 약 2m**) **멀티유즈 라운지** — 회의실 / 촬영 스튜디오 / 파티룸(모임). **무인 자동화 운영(셀프 이용)**
- 컨셉: **"분위기는 하나, 용도는 여럿"** / 코어 무드: 모던 + 우드 텍스처
- 비주얼: **기하 그래픽**(바우하우스·기하, 볼드 웜 컬러) + 레이어 분리(디지털 컬러풀 / 공간 재질) · 컬러 **메인(화이트·잉크)+엑센트(오렌지)** · 폰트 **Pretendard 통일** · 로고 **겹침(Overlapping Planes) 모티프**
- 네이밍: 🟢 **타입라운지 (TYPE LOUNGE) 확정** (2026-06-25)
- 로고: 심볼 컨셉 **타입의 겹침(Overlapping Planes)** — 태양·원 모티프 폐기, 겹침이 주인공 (컨셉 시안: `03-identity/logo-concepts.html`)

👉 시작점: **[05-design-system/README.md](./05-design-system/README.md)** (우산 문서)
👉 구축 계획: **[PLAN.md](./PLAN.md)** (합의 완료 v4)

## 구조

```
PLAN.md            구축 계획 (합의 완료)
01-strategy/       discovery · positioning · personas · brand-voice · visual-principles · moodboard
02-naming/         naming-criteria · candidates · validation
03-identity/       logo-guidelines · color-palette · typography · design-tokens
04-signage/        signage-system · exterior-signage · interior-wayfinding · pictograms
05-design-system/  README (우산 문서)
06-applications/     사이니지 시안 · 게스트 가이드 · 어드민 · 예약 자동화 · 공간 제어
assets/            무드보드 · 레퍼런스 이미지
```

## 공간 제어 (냉난방·조명)

합정 공간의 에어컨·조명을 어드민에서 원격으로 켜고 끕니다. `admin.html` → **공간 제어** 탭.

👉 설치 절차: **[06-applications/control-setup.md](./06-applications/control-setup.md)**

| | 구현 | 현장 장비 |
|---|---|---|
| 냉난방 | LG ThinQ Cloud API (HTTPS) | 불필요 |
| 조명 | Tasmota + 로컬 mosquitto + 상주 에이전트 | 합정에 맥 1대 |

## 검토 포인트 (사용자)

1. **네이밍** — ✅ 타입라운지 확정. 상표·도메인 라이브 확인만 잔여 (`02-naming/validation.md` §0)
2. **확정 입력** — ✅ 층고 약 2m · ✅ 무인 자동화 운영 / `[대기]` 가격대
3. 승인 시 로드맵 → **네이밍 확정 → +1주차 로고·픽토·사이니지 디자인 → +2주차 brand.md / bx.md / product.md / ux.md 배포**

> 실제 그래픽 제작(로고·픽토 벡터, 사이니지 실물)은 검토·승인 후 진행합니다.
