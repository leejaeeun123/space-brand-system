-- 공간 지원 프로그램 신청 접수 — 신청 내역이 남는 유일한 장부.
--
-- Mattermost 알림은 장부가 아니다. 채널은 지워지고 검색이 어렵고, 무엇보다 **웹훅이 실패해도
-- 신청은 접수돼야 한다.** 그래서 순서가 정해져 있다 — 이 테이블에 먼저 넣고, 알림은 그 뒤에
-- 최선 노력으로 보낸다(`functions/apply/index.ts`). 순서를 뒤집으면 채널이 죽어 있던 동안의
-- 신청이 통째로 사라지고, 신청자는 보냈다고 믿는다.
--
-- 설계 넷, 되돌리기 전에 읽을 것:
--
--  1) **RLS를 켜되 정책을 하나도 만들지 않는다.** `devices`·`reservation_sms`와 같은 방식이다.
--     신청 페이지(`apply.html`)는 anon key를 소스에 그대로 박고 배포되므로, 읽기 정책을 하나라도
--     열면 누구나 남의 이름·연락처·이메일을 통째로 긁어간다. **쓰기도 같다** — insert를 정책으로
--     열면 스팸이 Edge Function의 검증과 스팸 필터를 우회해 DB에 직접 꽂힌다.
--     service_role로 붙는 Edge Function이 유일한 경로다.
--
--  2) **동의를 boolean이 아니라 시각(`consented_at`)으로 남긴다.** 개인정보 수집·이용 동의는
--     "동의했다"가 아니라 "언제 동의했다"를 입증해야 하는 기록이다. 동의 문구는 시간이 지나면
--     바뀌는데, 어느 문구에 동의한 것인지는 시각으로만 되짚을 수 있다.
--
--  3) **보유기간 1년을 실제로 집행하는 것은 맨 아래 크론뿐이다.** 신청 페이지의 동의 문구는
--     그 크론을 사람에게 설명하는 문장일 뿐이다. CCTV 보관기간(`recordDeleteAfter`)과 똑같은
--     구조라 함정도 똑같다 — **둘 중 하나만 고치면 우리가 신청자에게 한 약속과 실제가 어긋난다.**
--     기간을 바꾸려면 여기와 `06-applications/apply.html`의 동의 문구를 같이 고친다.
--
--  4) **인스타그램만 not null이 아니다.** 계정이 없는 사람을 접수 자체에서 막지 않기 위해서다.
--     나머지 넷은 이것이 없으면 연락도 검토도 못 하므로 필수다.

create table if not exists public.support_applications (
  id bigint generated always as identity primary key,
  name text not null,
  phone text not null,
  email text not null,
  instagram text,
  purpose text not null,
  consented_at timestamptz not null,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);

comment on table public.support_applications is
  '공간 지원 프로그램 신청 내역. 접수의 정본 — Mattermost 알림은 이 표를 사람에게 알리는 사본일 뿐이다.';
comment on column public.support_applications.instagram is
  '핸들만 저장한다(@·URL 접두는 Edge Function이 벗긴다). null 허용 = 계정이 없어도 신청할 수 있다.';
comment on column public.support_applications.purpose is
  '활용 목적. 신청자가 쓴 원문 그대로 — 길이만 서버가 자른다(1000자).';
comment on column public.support_applications.consented_at is
  '개인정보 수집·이용에 동의한 시각. 서버가 접수 시각으로 찍는다 — 클라이언트가 보낸 시각을 믿지 않는다.';
comment on column public.support_applications.notified_at is
  'Mattermost 알림이 나간 시각. null = 접수는 됐는데 알림이 못 갔다(웹훅 미설정·장애). 채널만 보고 있으면 놓치는 신청이 이 컬럼으로 드러난다.';

create index if not exists support_applications_by_created
  on public.support_applications (created_at desc);

alter table public.support_applications enable row level security;

-- ── 보유기간 집행 ───────────────────────────────────────────────────────────
--
-- 이미 앞선 마이그레이션이 설치했지만, 이 파일만 따로 돌려도 되도록 다시 선언한다.
-- 스키마는 지정하지 않는다 — pg_cron은 relocatable이 아니라 자기 스키마를 요구한다
-- (20260807000000 참조).
create extension if not exists pg_cron;

-- 같은 이름으로 다시 부르면 갱신된다(pg_cron이 jobname으로 upsert). 마이그레이션을 다시 돌려도
-- 잡이 중복되지 않는다.
--
-- 새벽에 도는 다른 잡들과 분을 겹치지 않게 둔다(device-events-cleanup은 4시 17분).
select cron.schedule(
  'support-applications-purge',
  '31 4 * * *',
  $$
  delete from public.support_applications
  where created_at < now() - interval '1 year';
  $$
);
