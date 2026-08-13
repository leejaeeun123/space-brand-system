-- 어드민 비밀번호 대입 시도 제한.
--
-- 이 값 하나가 예약자 이름·연락처(admin_* RPC) · 주민번호 복호화(claim reveal) ·
-- CCTV 자격증명(camera_credentials) · 기기 전원을 전부 연다. 그런데 검증 경로가
-- 공개 엔드포인트 네 곳(PostgREST RPC + Edge Function 셋)이라 누구든 원격에서
-- 값을 무제한으로 던져볼 수 있었다. 비밀번호를 길게 바꾸는 것과 별개로,
-- **던져볼 수 있는 횟수 자체**를 자르는 층이 필요하다.
--
-- 세는 것은 **실패한 인증 시도뿐**이다. 성공도, 비밀번호를 아예 안 보낸 요청도 안 센다 —
-- pg_cron이 1분마다 부르는 automate가 후자에 해당하고, 그걸 세면 자동화가 스스로
-- 문을 잠근다(#44·#70에서 자동화가 침묵으로 죽은 전례가 있다).
create table if not exists public.auth_attempts (
  id bigint generated always as identity primary key,
  ip text not null,
  fn text not null,
  at timestamptz not null default now()
);

comment on table public.auth_attempts is
  '어드민 비밀번호 인증 실패 기록. 대입 시도 제한의 근거이며, 성공한 인증은 남기지 않는다.';
comment on column public.auth_attempts.fn is
  '어느 함수에서 실패했는지(control·claim·apply). 한 IP가 여러 표면을 훑는 것을 구분하려고 남긴다.';

-- 조회는 항상 "이 IP가 최근 N분간 몇 번 실패했나"라서 (ip, at) 순서가 맞다.
create index if not exists auth_attempts_ip_at on public.auth_attempts (ip, at desc);

-- RLS on + 정책 없음 = service_role만 접근. anon 키로는 읽지도 쓰지도 못한다.
-- (이 레포의 다른 테이블과 같은 태도 — 정책을 안 만드는 것이 곧 잠그는 것이다.)
alter table public.auth_attempts enable row level security;

-- 실패 기록은 차단 판정에만 쓰이므로 오래 들고 있을 이유가 없다.
-- 판정 창(10분)보다 넉넉하게 두되, 반복 공격의 흔적은 하루 정도 남겨 사람이 볼 수 있게 한다.
create extension if not exists pg_cron;

select cron.schedule(
  'auth-attempts-cleanup',
  '23 4 * * *',
  $$
  delete from public.auth_attempts where at < now() - interval '1 day'
  $$
);
