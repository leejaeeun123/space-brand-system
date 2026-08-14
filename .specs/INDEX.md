# 스펙 인덱스

> 전체 스펙 목록 및 상태를 관리합니다.

## 스펙 목록

| 스펙 | 상태 | 스프린트 | 담당자 | 의존성 | 최종 갱신 |
|------|------|---------|--------|--------|----------|
| [cleaning_sms](spec_cleaning_sms/spec.md) | 🟢 | - | hyungwoon | - | 2026-08-09 |
| [reservation_sync](spec_reservation_sync/spec.md) | ✅ | - | hyungwoon | - | 2026-08-14 |
| [guest_sms](spec_guest_sms/spec.md) | ✅ | - | hyungwoon | spec_reservation_sync | 2026-08-14 |
| [space_control](spec_space_control/spec.md) | ✅ | - | hyungwoon | spec_admin_auth | 2026-08-14 |
| [reservation_automation](spec_reservation_automation/spec.md) | ✅ | - | hyungwoon | spec_space_control | 2026-08-14 |
| [cctv](spec_cctv/spec.md) | ✅ | - | hyungwoon | spec_admin_auth | 2026-08-14 |
| [support_apply](spec_support_apply/spec.md) | ✅ | - | hyungwoon | spec_admin_auth | 2026-08-14 |
| [payback_claim](spec_payback_claim/spec.md) | ✅ | - | hyungwoon | spec_admin_auth | 2026-08-14 |
| [admin_auth](spec_admin_auth/spec.md) | ✅ | - | hyungwoon | - | 2026-08-14 |

> ✅ 8건(reservation_sync ~ admin_auth)은 2026-08-14 라이브 시스템을 역기획한 스펙이다 — 기능은 구현·운영 중이고, 각 PROGRESS.md의 "남은 일"에 미검증·후속 항목이 남아 있다. 상위 요구사항 정본: [`docs/prd/typelounge-ops/typelounge-ops-PRD.md`](../docs/prd/typelounge-ops/typelounge-ops-PRD.md)

## 상태 범례

| 아이콘 | 상태 | 설명 |
|--------|------|------|
| 🟢 | 진행중 | 현재 개발이 진행 중인 스펙 |
| 🟡 | 보류 | 일시적으로 중단된 스펙 (사유를 PROGRESS.md에 기록) |
| ✅ | 완료 | 개발 및 QA가 완료된 스펙 |
| ❌ | 폐기 | 기획 변경 등으로 폐기된 스펙 (삭제하지 않고 상태만 변경) |

## 갱신 규칙
- 새 스펙을 생성하면 이 파일에 즉시 추가합니다.
- 스펙 상태가 변경되면 이 파일을 함께 갱신합니다.
- 완료 및 폐기된 스펙은 목록 하단으로 이동시킵니다.
