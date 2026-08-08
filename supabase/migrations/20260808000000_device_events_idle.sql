-- 장부가 말할 수 있는 사건을 둘 넓힌다.
--
-- ── 1. `idle` — 예약이 없는데 켜져 있다 ────────────────────────────────────────
-- 기기를 끄는 길이 지금까지 둘뿐이었고 **둘 다 살아있는 예약 행에 매달려 있었다**:
-- 퇴실 종료(`schedule.ts`)와 퇴실 후 10분 스윕(`enforce.ts`). 그래서 예약이 사라지거나
-- 창을 놓치면 아무도 끄지 않는다 —
--
--   · 이용 중 취소·삭제 → `fetchRecent`의 `cancelled = false`에서 빠져 대상 자체가 없어진다
--   · 함수가 10분 넘게 죽어 있다 살아남 → 종료도 스윕도 `expired`로 지나간다
--   · 빈 시간에 사람이 그냥 켬 → 애초에 어떤 창에도 안 걸린다
--
-- 셋 다 냉난방이 밤새 도는 결과가 같고, 지금은 채널에 한 줄도 안 뜬다.
--
-- **끄지는 않는다.** 빈 시간에 사람이 일부러 켜둔 것(청소·예열·촬영 답사)까지 되돌리면
-- 자동화가 사람과 싸우고, 그 싸움은 현장에 있는 사람이 진다. 알리는 것까지가 안전한 경계다.
--
-- ── 2. `device_id`를 nullable로 ───────────────────────────────────────────────
-- 전환(입실 준비·퇴실 종료)이 **만료되거나 시작조차 못 한** 실패는 특정 기기의 일이 아니다.
-- 기기를 하나 골라 적으면 거짓이고, 전 기기에 하나씩 적으면 실패 한 건이 표 여섯 줄이 된다.
-- 공간 전체를 뜻하는 null 한 줄로 적는다(`notify`가 '공간 전체'로 렌더한다).
--
-- 개별 명령의 실패는 지금처럼 그대로 기기별로 남는다 — 그건 실제로 기기의 일이다.

-- 조건 없이 drop 한다. `if exists`로 두면 이름이 다를 때 조용히 넘어가고, 이어지는 add가
-- 성공해 **제약이 둘 다 남는다** — 옛 제약이 여전히 'idle'을 거부하는데 마이그레이션은
-- 성공한 것처럼 보이는, 가장 나쁜 실패 방식이다. (같은 이유로 20260807120000의 rename도
-- 조건을 안 걸었다.)
alter table public.device_events drop constraint device_events_kind_check;

alter table public.device_events add constraint device_events_kind_check
  check (kind in (
    'prep', 'shutdown', 'sweep', 'temp_floor',
    'remote_admin', 'remote_guest', 'onsite', 'idle'
  ));

alter table public.device_events alter column device_id drop not null;

comment on column public.device_events.device_id is
  'null = 특정 기기가 아니라 공간 전체의 사건(전환 만료·전환 자체의 실패). 기기별 명령 실패는 여기에 기기 id가 그대로 들어간다.';

-- 틱마다 kind로 좁혀 훑는 조회가 넷이다 — 현장 조작 대조(명령 kind 화이트리스트),
-- 스윕 중복 억제, 유휴 경보 중복 억제, 유휴 경보의 '최근 사람 조작' 면제.
-- 기존 인덱스는 (at) where notified_at is null 과 (device_id, at desc)라 어느 쪽도 못 탄다.
create index if not exists device_events_kind_idx
  on public.device_events (kind, at desc);
