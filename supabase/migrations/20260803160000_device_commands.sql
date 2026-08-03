-- 조명(Tasmota) 명령 큐 + 감사 로그.
--
-- **왜 큐가 필요한가**: 합정 맥은 NAT 뒤라 Edge Function이 직접 MQTT를 쏠 수 없다.
-- 그래서 Edge Function은 여기에 행을 넣기만 하고, 합정 에이전트가 Realtime(아웃바운드
-- WebSocket)으로 그 INSERT를 받아 로컬 mosquitto에 발행한다. 인바운드 포트 개방 0.
--
-- 폴링을 안 쓰는 이유는 비용이다. 조명 반응이 1초 안이어야 쓸 만한데, 1초 폴링이면
-- 월 260만 호출로 Supabase 무료 한도(50만)를 넘는다. Realtime은 상시 연결 하나다.
--
-- Space에도 device_commands가 있었지만 **어느 경로도 여기에 쓰지 않았다**(그쪽 PROGRESS.md
-- GAP-2: "누가 어떤 기기에 무슨 명령을 눌렀나가 전혀 남지 않는다"). 여기서는 이 테이블이
-- 전송 경로 그 자체라서, 감사 로그가 부산물로 자동으로 남는다.

create table if not exists public.device_commands (
  id           uuid primary key default gen_random_uuid(),
  device_id    uuid not null references public.devices(id) on delete cascade,
  command      text not null,
  payload      jsonb not null default '{}'::jsonb,
  -- pending = 에이전트가 아직 안 집어감 / sent = mosquitto에 발행됨
  -- expired  = 너무 오래된 명령이라 실행하지 않고 버림 (아래 참조)
  -- failed   = 발행 시도했으나 실패
  status       text not null default 'pending'
                 check (status in ('pending', 'sent', 'expired', 'failed')),
  error        text,
  requested_at timestamptz not null default now(),
  sent_at      timestamptz
);

-- 에이전트가 재접속 직후 밀린 pending을 훑을 때 쓰는 인덱스.
create index if not exists device_commands_pending_idx
  on public.device_commands (status, requested_at)
  where status = 'pending';

alter table public.device_commands enable row level security;

-- ⚠️ 에이전트가 오래된 pending을 **실행하지 않고 버리는** 것이 중요하다.
-- 맥이 몇 시간 꺼져 있다가 켜졌을 때 밀린 명령을 그대로 재생하면 새벽 3시에 조명이 켜진다.
-- TTL 판정은 에이전트가 requested_at으로 하고(상수는 에이전트 코드에 있다), 지난 것은
-- expired로 마킹만 한다. DB가 아니라 에이전트가 판단하는 이유는 '지금'이 에이전트 쪽
-- 시계이고, 그쪽이 실제로 발행 여부를 결정하는 주체이기 때문이다.

-- Realtime 발행 대상에 추가 — 에이전트가 INSERT를 밀어서 받는다.
-- (이미 들어 있으면 에러가 나므로 방어적으로 감싼다.)
do $$
begin
  alter publication supabase_realtime add table public.device_commands;
exception
  when duplicate_object then null;
end $$;
