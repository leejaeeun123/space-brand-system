-- 연결 끊김 감지 + 시스템 오류 알림 — 장부가 말할 수 있는 사건을 다섯 더 넓힌다.
--
-- 지금까지 장부는 "우리가 기기에 명령을 보냈다 / 손님이 만졌다"만 알았다. 조명이 MQTT에서
-- 조용히 떨어지거나 CCTV 스트림이 죽어도, 사람이 어드민을 열어보기 전까진 채널에 한 줄도
-- 뜨지 않았다 — `automate` 자체가 예외를 삼키고 console에만 남긴 서브시스템 실패도 마찬가지다.
-- 08-08/08-09의 "조용한 실패" 사고들과 같은 종류를 이번엔 미리 막는다.

-- ── 1. 카메라도 사건의 대상이 될 수 있게 ────────────────────────────────────────
-- 기존 device_id는 devices(id) FK라 카메라(별도 cameras 테이블, 20260803170000)를 가리킬 수
-- 없다. camera_id를 nullable로 더하고, 한 행은 device_id/camera_id 중 최대 하나만 채운다
-- (둘 다 null = 공간 전체 사건, 20260808000000이 정한 기존 의미 그대로 유지).
alter table public.device_events
  add column if not exists camera_id uuid references public.cameras(id) on delete cascade;

alter table public.device_events
  drop constraint if exists device_events_target_check;
alter table public.device_events
  add constraint device_events_target_check
  check (device_id is null or camera_id is null);

create index if not exists device_events_camera_idx
  on public.device_events (camera_id, at desc);

comment on column public.device_events.camera_id is
  'device_id와 배타적. 둘 다 null = 공간 전체 사건(예: system_error).';

-- ── 2. 새 kind 다섯 ──────────────────────────────────────────────────────────
-- device_offline/device_recovered: 조명(Tasmota LWT)·냉난방(ThinQ 조회) 연결 끊김/복구.
-- camera_offline/camera_recovered: CCTV(MediaMTX) 연결 끊김/복구.
-- system_error: automate 실행 중 서브시스템(관측·문자·청소·알림 발송)이 삼켰던 예외.
--
-- 조건 없이 drop 한다. `if exists`로 두면 이름이 다를 때 조용히 넘어가고, 뒤이은 add가 성공해
-- 옛 제약이 남는 가장 나쁜 실패 방식이 된다(20260808000000의 선례를 따른다).
alter table public.device_events drop constraint device_events_kind_check;
alter table public.device_events add constraint device_events_kind_check
  check (kind in (
    'prep', 'shutdown', 'sweep', 'temp_floor',
    'remote_admin', 'remote_guest', 'onsite', 'idle',
    'device_offline', 'device_recovered',
    'camera_offline', 'camera_recovered',
    'system_error'
  ));

-- system_error는 device_id/camera_id 없이 action(서브시스템 이름)으로만 최근 이력을 조회한다
-- — 같은 원인이 반복될 때 재알림 간격을 두기 위해서다. 안 두면 enforce.ts의 온도 하한 강제가
-- 겪었던 사고(만료된 PAT 하나가 3시간 예약 동안 175건을 남겼다)가 여기서도 재현된다.
create index if not exists device_events_action_idx
  on public.device_events (kind, action, at desc);
