-- automate 틱의 생존을 감시하는 **게이트 밖 독립 주체**.
--
-- 문제: 게이트가 automate를 막는 회귀가 배포되면(#44·#70에서 실제로 두 번) index.ts가 automate
-- 진입 전에 403을 반환해 장부에 아무것도 안 남고, pg_net이 비동기라 cron.job_run_details엔
-- '성공'만 남는다. #71 알림 체계는 automate가 실행돼야 작동하므로 이 실패 모드를 못 본다.
--
-- 고침: automate가 한 바퀴 정상 완주하면 하트비트를 갱신하고(automation/heartbeat.ts),
-- Edge Function을 거치지 않는 이 pg_cron SQL 잡이 "하트비트가 낡음"이면 Mattermost로 직접
-- 알린다. 감시 주체가 automate와 **다른 실행 경로**에 있어야 automate가 통째로 죽는 실패를
-- 볼 수 있다.
--
-- ⚠️ **배포 순서 — 마이그레이션이 먼저다.** 이 파일이 함수 배포보다 먼저 올라간다. 그 사이
-- (배포 전) beat_at은 갱신되지 않으므로 alerted_at도 now()로 초기화해 ~55분의 배포 유예를 둔다.

-- ── 1. 하트비트 ──────────────────────────────────────────────────────────────
-- 단일 행(id=1). beat_at=마지막 완주 시각, alerted_at=마지막으로 낡음을 알린 시각(재알림 억제).
create table if not exists public.automation_heartbeat (
  id         smallint primary key default 1 check (id = 1),
  beat_at    timestamptz not null,
  alerted_at timestamptz
);

-- alerted_at을 now()로 초기화하는 이유는 위 배포 순서 주석 참조 — 배포 유예 뒤엔 정상 beat가
-- alerted_at을 null로 되돌려 재무장한다.
insert into public.automation_heartbeat (id, beat_at, alerted_at)
values (1, now(), now())
on conflict (id) do nothing;

comment on table public.automation_heartbeat is
  'automate 생존 하트비트(단일 행). beat_at=마지막 정상 완주, alerted_at=감시 잡의 마지막 알림(억제용).';

-- devices·device_events와 같은 이유로 RLS를 켜되 정책을 두지 않는다 = anon 키로는 접근 불가.
-- pg_cron 잡은 스케줄링 역할(테이블 소유자)로 돌아 RLS와 무관하게 읽는다 —
-- 기존 device-events-cleanup 잡이 RLS를 켠 device_events를 지우는 것과 같다.
alter table public.automation_heartbeat enable row level security;

-- ── 2. 웹훅 주소 설정값 ──────────────────────────────────────────────────────
-- 웹훅 URL은 **시크릿이라 마이그레이션에 평문으로 박지 않는다**(이 레포는 시크릿 커밋 금지).
-- 형운이 DB에 직접 넣는다 (automation/notify.ts의 기기 웹훅과 같은 값을 쓰면 된다):
--
--   insert into public.automation_config (key, value)
--   values ('heartbeat_webhook_url', 'https://<mattermost incoming webhook URL>')
--   on conflict (key) do update set value = excluded.value;
--
-- 값이 없으면(행이 없거나 빈 문자열) 감시 잡은 **조용히 아무것도 안 한다** — 설정 안 된 상태가
-- 오작동이 되면 안 된다.
create table if not exists public.automation_config (
  key   text primary key,
  value text
);
alter table public.automation_config enable row level security;

-- ── 3. 감시 잡 ───────────────────────────────────────────────────────────────
-- pg_cron/pg_net은 relocatable이 아니라 스키마를 지정하지 않는다(20260807000000 참조).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 5분마다: 하트비트가 10분 넘게 낡았고(=automate가 10틱 이상 미실행 = 확실한 정지), 최근 55분
-- 안에 안 알렸으면 웹훅으로 직접 알린다. 55분 억제로 한 시간에 한 번꼴로 묶는다
-- (connectivity.ts의 60분 재알림과 같은 철학 — 며칠 이어지는 정지에서 5분마다 알리면 주말에
-- 수백 건이 쌓인다). 정상 완주가 alerted_at을 null로 되돌리므로 회복 후 재정지는 즉시 알린다.
select cron.schedule(
  'automation-heartbeat-watchdog',
  '*/5 * * * *',
  $cron$
  do $watchdog$
  declare
    v_url     text;
    v_beat    timestamptz;
    v_alerted timestamptz;
  begin
    select value into v_url from public.automation_config where key = 'heartbeat_webhook_url';
    if v_url is null or v_url = '' then return; end if;  -- 미설정 → 조용히 아무것도 안 한다

    select beat_at, alerted_at into v_beat, v_alerted
      from public.automation_heartbeat where id = 1;
    if v_beat is null then return; end if;                          -- 행이 없다(방어)
    if v_beat >= now() - interval '10 minutes' then return; end if; -- 신선 → 정상
    if v_alerted is not null and v_alerted >= now() - interval '55 minutes' then
      return;                                                       -- 최근에 이미 알렸다
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'text',
        '⚠️ **무인 자동화 정지 감지** — automate가 ' ||
        floor(extract(epoch from (now() - v_beat)) / 60)::text ||
        '분째 실행되지 않았습니다. 게이트 회귀(#44·#70)나 pg_cron 중단을 확인하세요. ' ||
        '마지막 완주: ' || to_char(v_beat at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') || ' KST'
      ),
      timeout_milliseconds := 10000
    );
    update public.automation_heartbeat set alerted_at = now() where id = 1;
  end
  $watchdog$;
  $cron$
);
