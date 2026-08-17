-- 퇴실 독려 — 퇴실 시각이 지났는데 라운지에 움직임이 남아 있으면 운영자에게 알린다.
--
-- 지금까지 퇴실 후에 도는 것은 기기를 다시 끄는 스윕(SWEEP_WINDOW_MINUTES=10)뿐이었다.
-- 조명은 껐지만 **사람이 아직 안에 있다**는 사실은 아무도 몰랐다. 카메라의 움직임 감지를
-- 판정 근거로 삼아, 조명을 끄는 것과 같은 결의 알림을 그 옆에 나란히 붙인다.
--
-- 영상은 여전히 서버를 지나지 않는다. 현장 에이전트가 카메라에서 ONVIF로 **"움직임이 있었다"는
-- 사실 하나**만 받아 적고, 그 시각만 여기 올라온다. 프레임도 스냅샷도 저장하지 않는다.

-- ── 1. 움직임 관측 적립 ──────────────────────────────────────────────────────
-- 카메라 1대당 1행. 이력을 쌓지 않는 이유는 판정에 필요한 것이 "창 안에 움직임이 있었나"
-- 하나뿐이기 때문이다 — 마지막 시각만 있으면 `last_motion_at >= 창 시작`으로 답이 나온다.
-- 이력을 쌓으면 사람이 있었던 시간대가 통째로 DB에 남는데, 그건 우리가 필요로 하지 않는
-- 개인정보를 보관하는 것이다(§25의 취지에도 맞지 않는다).
create table if not exists public.camera_motion (
  camera_id uuid primary key references public.cameras(id) on delete cascade,

  -- 마지막으로 움직임을 관측한 시각. **카메라가 이벤트에 실어 보낸 시각**을 쓴다(우리가 받은
  -- 시각이 아니다). 폴링 간격만큼 늦게 받으므로, 수신 시각으로 적으면 퇴실 직전의 움직임이
  -- 창 안으로 밀려 들어와 이미 나간 손님을 붙잡는다. 카메라 시계는 맥과 1초 이내로 맞다(실측).
  --
  -- null = 감시를 시작한 뒤 한 번도 움직임이 없었다. 기본값을 now()로 주지 않는다 —
  -- '방금 움직였다'는 거짓말이 되고, 하필 첫 퇴실에서 오탐을 만든다.
  last_motion_at timestamptz,

  -- 감시자가 마지막으로 **정상 폴링**한 시각. 이게 낡으면 '움직임 없음'이 아니라 '모름'이다.
  -- 둘을 합치면 감시자가 죽은 채로 "아무도 없습니다"가 조용히 참이 된다 —
  -- `power = null`을 'OFF'로 합치지 않는 것과 같은 이유다.
  observed_at timestamptz not null
);

comment on table public.camera_motion is
  '카메라별 마지막 움직임 관측. 영상·스냅샷은 저장하지 않고 시각만 적는다. 현장 에이전트가 ONVIF로 관측해 upsert.';
comment on column public.camera_motion.last_motion_at is
  '카메라가 이벤트에 실어 보낸 시각(수신 시각이 아니다). null = 감시 시작 후 움직임 없음.';
comment on column public.camera_motion.observed_at is
  '감시자가 마지막으로 정상 폴링한 시각. 낡으면 ''움직임 없음''이 아니라 ''모름''이다.';

-- cameras·camera_state와 같은 태도 — 정책을 하나도 두지 않아 anon 키로는 읽기도 쓰기도 안 된다.
-- 접근은 Edge Function(service_role)과 현장 에이전트뿐이다.
alter table public.camera_motion enable row level security;

-- ── 2. 새 kind ──────────────────────────────────────────────────────────────
-- checkout_overdue: 퇴실 후 창 안에서 움직임이 관측됐다(관측만 — 아무것도 끄지 않는다).
--
-- 조건 없이 drop 한다. `if exists`로 두면 이름이 다를 때 조용히 넘어가고, 뒤이은 add가 성공해
-- 옛 제약이 남는 가장 나쁜 실패 방식이 된다(20260812130000의 선례를 따른다).
alter table public.device_events drop constraint device_events_kind_check;
alter table public.device_events add constraint device_events_kind_check
  check (kind in (
    'prep', 'shutdown', 'sweep', 'temp_floor',
    'remote_admin', 'remote_guest', 'onsite', 'idle',
    'device_offline', 'device_recovered',
    'camera_offline', 'camera_recovered',
    'checkout_overdue',
    'system_error'
  ));
