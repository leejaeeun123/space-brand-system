-- 주민번호·계좌 복호화(`reveal`) 접속기록.
--
-- **왜 별도 테이블인가.** 기록을 `payback_claims` 행에 얹으면 그 행의 파기 주기(지급 1년 뒤,
-- 반려 즉시)를 같이 따라가 사라진다. 접속기록은 그보다 오래 살아야 한다 — 「개인정보의
-- 안전성 확보조치 기준」이 고유식별정보 취급 기록을 2년 보관하도록 요구하고, 무엇보다
-- '언제 누가 열었나'는 사고가 난 **뒤에** 필요한 정보라서 원본이 지워진 뒤에도 남아야 한다.
--
-- 남기는 것은 **누가 언제 어느 건을 열었나**까지다. 복호화된 값 자체는 절대 안 남긴다 —
-- 그러면 이 표가 곧 두 번째 주민번호 저장소가 된다(claim/store.ts가 로그에 안 찍는 이유와 같다).
create table if not exists public.payback_reveal_log (
  id bigint generated always as identity primary key,
  claim_id bigint not null references public.payback_claims(id) on delete cascade,
  at timestamptz not null default now(),
  ip text
);

comment on table public.payback_reveal_log is
  '주민번호·계좌 복호화 접속기록. 고유식별정보라 payback_claims(1년)보다 오래 보관한다 — 그래서 같은 행에 두지 않는다. 복호화된 값은 남기지 않는다.';
comment on column public.payback_reveal_log.claim_id is
  '어느 신청 건을 열었나. 원본이 파기돼도 기록은 남아야 하지만, 신청 자체가 사라지면(cascade) 가리킬 대상도 없어진다.';

create index if not exists payback_reveal_log_at on public.payback_reveal_log (at desc);

-- RLS on + 정책 없음 = service_role만. 접속기록을 열람 대상이 스스로 지울 수 있으면 의미가 없다.
alter table public.payback_reveal_log enable row level security;

-- 2년이 지난 기록은 지운다. 보관 의무 기간이 끝나면 이것도 개인정보다.
create extension if not exists pg_cron;

select cron.schedule(
  'payback-reveal-log-purge',
  '47 4 * * *',
  $$
  delete from public.payback_reveal_log where at < now() - interval '2 years'
  $$
);
