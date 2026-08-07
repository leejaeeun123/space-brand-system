-- 기기 조작 이벤트 장부 + 자동화가 기억하는 기기 상태.
--
-- 이 두 가지가 함께 있어야 **현장 조작**을 가려낼 수 있다. 조명 벽 스위치와 에어컨 리모컨은
-- 우리 API를 거치지 않으므로 직접 관측할 방법이 없다. 대신 이렇게 추론한다:
--
--   관측된 상태 변화  −  우리가 보낸 명령(장부)  =  현장 조작
--
-- 즉 현장 조작은 관측이 아니라 **잔여 범주**다. 그래서 장부가 비거나 늦으면 우리가 켠 것을
-- "현장에서 누가 켰다"고 잘못 알린다 — 대조 창(코드의 120초)이 조명 큐 지연을 덮어야 하는 이유다.

-- ── 1. 명령·이벤트 장부 ──────────────────────────────────────────────────────
create table if not exists public.device_events (
  id          bigserial primary key,
  device_id   uuid not null references public.devices(id) on delete cascade,
  at          timestamptz not null default now(),
  -- 무슨 일이었나. 알림의 제목이 여기서 나온다.
  -- 앞의 넷은 자동화가 일으킨 것, remote_*는 사람이 원격에서, onsite는 추론된 현장 조작.
  kind        text not null check (kind in (
                'prep', 'shutdown', 'sweep', 'temp_floor',
                'remote_admin', 'remote_guest', 'onsite'
              )),
  action      text not null,          -- 'power_on' | 'set_temp' | 'observed' ...
  value       text,                   -- 온도·모드 같은 값, 또는 현장 조작의 '꺼짐 → 켜짐'
  status      text not null check (status in ('ok', 'failed')),
  detail      text,                   -- 실패 사유
  -- null = 아직 알림을 안 보냈다. 틱이 이걸 모아 한 건으로 보내고 시각을 채운다.
  notified_at timestamptz
);

-- 틱마다 "아직 안 보낸 것"을 훑는다 — 부분 인덱스라 보낸 것들은 인덱스에 남지 않는다.
create index if not exists device_events_pending_idx
  on public.device_events (at) where notified_at is null;

-- 현장 조작 판별이 "이 기기에 최근 명령이 있었나"를 묻는다.
create index if not exists device_events_recent_idx
  on public.device_events (device_id, at desc);

-- devices와 같은 이유로 RLS를 켜되 정책을 만들지 않는다 = anon 키로는 접근 불가,
-- Edge Function(service_role)만이 유일한 경로다. 이 장부는 언제 누가 공간의 기기를
-- 만졌는지를 통째로 담고 있어 예약 정보만큼이나 새면 안 된다.
alter table public.device_events enable row level security;

-- ── 2. device_temp_floor → device_watch ─────────────────────────────────────
-- 온도 하한 시계만 담던 테이블에 "마지막으로 관측한 상태"가 더해지면서 이름이 좁아졌다.
-- 둘 다 '자동화가 이 기기에 대해 기억하는 것'이라 한 테이블로 둔다.
-- rename은 조건 없이 한다. `if exists`로 두면 이름이 이미 다를 때 조용히 넘어가고, 바로 다음
-- alter가 엉뚱한 곳에서 터져 원인이 가려진다. 없으면 여기서 분명하게 실패하는 편이 낫다.
alter table public.device_temp_floor rename to device_watch;

alter table public.device_watch
  add column if not exists last_power text,
  add column if not exists last_temp  numeric,
  add column if not exists seen_at    timestamptz;

-- 이제 행이 있다 = '이 기기를 관측한 적이 있다'이지 '하한 미만이다'가 아니다.
-- 하한 판정은 below_since가 null인지로 한다.
alter table public.device_watch alter column below_since drop not null;

comment on table public.device_watch is
  '자동화가 기기에 대해 기억하는 것. below_since=하한 미만 가동 시작 시각(null=정상), last_*=마지막으로 관측한 상태(현장 조작 판별의 기준선).';

-- ── 3. 장부 정리 ────────────────────────────────────────────────────────────
-- 매 틱 쌓이므로 그냥 두면 무한히 자란다. 알림까지 끝난 30일 이전 것만 지운다 —
-- 아직 안 보낸 것은 아무리 오래됐어도 남긴다(못 보낸 이유를 나중에 봐야 한다).
-- 발송이 끝난 것은 30일, **못 보낸 것도 7일이면 버린다.** 미발송을 무기한 남기면 웹훅이
-- 오래 죽어 있을 때 테이블이 무한히 자라고, 살아난 뒤엔 밀린 것이 통째로 한 메시지가 되어
-- 길이로 거절당하는 악순환에 빠진다. 일주일 지난 조작 알림은 어차피 쓸모가 없다.
select cron.schedule(
  'device-events-cleanup',
  '17 4 * * *',
  $$
  delete from public.device_events
  where (notified_at is not null and at < now() - interval '30 days')
     or (notified_at is null     and at < now() - interval '7 days');
  $$
);
