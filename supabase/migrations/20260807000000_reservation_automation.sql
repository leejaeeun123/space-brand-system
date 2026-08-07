-- 예약 체크인 15분 전 냉난방·조명 자동 준비, 체크아웃 시각 자동 전원 끄기.
--
-- 스케줄러(pg_cron)는 1분마다 Edge Function(control)의 automate action을 찌르기만 한다 —
-- '지금 어떤 예약이 대상인가'는 여기서 SQL로 계산하지 않는다. 그 판단은
-- supabase/functions/control/handlers/automation.ts가 갖는다: 날짜+시각 산술은 SQL 표현식보다
-- TS Date가 읽기 쉽고, 기기 목록 조회·명령 발행도 어차피 같은 파일이 해야 해서 판단 로직을
-- SQL과 TS로 나눠 두면 한쪽만 고쳐지는 순간 어긋난다.
--
-- 인증: automate action은 guest 권한으로 연다(auth.ts). 손님 페이지가 이미 같은 조명·냉난방
-- 명령을 비밀번호 없이 부를 수 있어(2026-08-04 정책) 이 action이 새로 여는 권한은 없다 —
-- 대상 예약도 호출자가 고르지 못한다(서버가 지금 시각 기준으로 직접 계산한다). 그래서
-- anon key만 있으면 되고, ADMIN_PASSWORD를 pg_cron에 심을 필요가 없다.

alter table public.reservations
  add column if not exists checkin_automation_at timestamptz;
comment on column public.reservations.checkin_automation_at is
  '입실 자동화(냉난방 26도+조명) 실행 시각. null = 아직 실행 안 됨. 대상 창(입실 15분 전 기준 10분)을 놓쳐 건너뛴 경우도 채운다(무한 재시도 방지) — 이 컬럼만으로 기기에 실제로 명령이 갔는지는 확정할 수 없다.';

alter table public.reservations
  add column if not exists checkout_automation_at timestamptz;
comment on column public.reservations.checkout_automation_at is
  '퇴실 자동화(전원 전체 끄기) 실행 시각. null = 아직 실행 안 됨. checkin_automation_at과 같은 의미.';

-- 스키마를 지정하지 않는다. 둘 다 **relocatable이 아니라** 자기 스키마(`cron`·`net`)를
-- 요구하고, `with schema extensions`를 붙이면 아직 설치 안 된 프로젝트에서 생성 자체가 실패한다
-- (이미 설치돼 있으면 if not exists가 먹어 조용히 넘어가 더 헷갈린다).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- anon key는 비밀이 아니다 — admin.html·guest-control.html 소스에 이미 그대로 박혀 공개돼 있다.
-- (이 값이 회전되면 이 잡도 같이 갱신해야 한다 — 진실의 원천은 두 HTML의 SUPABASE_ANON_KEY.)
select cron.schedule(
  'reservation-automation',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://sewqusncgznypjigmfde.supabase.co/functions/v1/control',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNld3F1c25jZ3pueXBqaWdtZmRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2NzM3OTAsImV4cCI6MjEwMTI0OTc5MH0.cMoaJUulz7m56aWQ8neQm013c75dGbCIuzEd8MS2vnI"}'::jsonb,
    body := '{"action":"automate"}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);
