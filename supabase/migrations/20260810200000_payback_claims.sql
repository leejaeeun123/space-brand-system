-- 지원금(페이백) 신청 장부 — 공간 지원 프로그램 참여자가 이용 비용을 청구하는 곳.
--
-- **이 표는 이 레포에서 가장 민감한 데이터를 담는다.** 주민등록번호와 계좌번호다.
-- 되돌리기 전에 아래 다섯을 읽는다.
--
--  1) **주민번호 암호화는 선택이 아니라 법이다.** 「개인정보 보호법」 §24-2③이 안전성 확보에
--     필요한 조치(암호화 저장)를 강행 규정으로 두고 있다. 수집 자체의 근거는 동의가 아니라
--     소득세법이다 — 3.3% 원천징수와 지급명세서 제출에 주민번호가 필요하다. 즉 "동의를 받았으니
--     평문으로 둬도 된다"는 성립하지 않는다.
--
--  2) **암호화는 여기(DB)가 아니라 Edge Function에서 한다.** pgcrypto를 쓰면 키가 SQL 문에
--     실려 쿼리 로그·에러 메시지에 남을 수 있다. 그래서 `*_enc` 컬럼은 이 DB가 열 수 없는
--     암호문이고, 키(`RRN_ENCRYPTION_KEY`)는 Edge Function 시크릿에만 있다.
--     **DB가 통째로 새도 주민번호는 안 새는 것**이 이 구조의 목적이다.
--
--  3) **마스킹 값을 따로 저장한다.** 어드민 목록은 `*_masked`만 읽어 그린다 — 화면을 한 번
--     그릴 때마다 주민번호를 복호화하면, 볼 필요가 없는 순간에도 평문이 만들어진다.
--     복호화는 사람이 '보기'를 누른 그 한 건에만 일어난다.
--
--  4) **파기 시점은 달력이 아니라 생애주기에 매달린다.** 주민번호는 지급명세서를 내기 위해
--     존재하므로, 제출 전에 지우면 목적 자체를 못 이룬다. 그래서 `status`·`paid_at`이 있어야
--     파기 크론이 걸 곳이 생긴다(기능 욕심이 아니라 파기의 전제다).
--     · 지급완료 → 지급 1년 뒤 암호문 파기 (형운 결정, 2026-08-10)
--     · 반려 → **즉시** 파기. 지급하지 않으면 지급명세서도 없고, 근거가 사라진 개인정보는
--       지체 없이 파기해야 한다. 이건 크론이 아니라 반려를 누른 그 순간 함수가 지운다.
--     · 접수된 채 1년 방치 → 파기. 안 그러면 아무도 안 건드린 건이 영원히 남는다.
--
--  5) **행은 지우지 않고 암호문만 지운다.** 누구에게 얼마를 언제 지급했는가는 회계 기록이라
--     남아야 하고, 주민번호·계좌는 남으면 안 된다. 둘을 한 행에 두되 파기 대상을 컬럼으로
--     가른 이유가 이것이다.

create table if not exists public.payback_claims (
  id bigint generated always as identity primary key,

  -- 신청자 (마스킹 대상 아님 — 대조와 연락에 쓴다)
  name text not null,
  phone text not null,
  email text not null,

  -- 청구 내용. booking_no는 null 허용 — 전화 예약은 예약번호가 없다(reservations와 같은 사정).
  booking_no text,
  used_on date not null,
  amount integer not null check (amount > 0),

  -- 계좌. 은행·예금주는 그대로, 번호만 암호문 + 마스킹.
  bank text not null,
  account_holder text not null,
  account_enc text,
  account_masked text not null,

  -- 주민번호. 평문 컬럼은 존재하지 않는다 — 만들면 언젠가 채워진다.
  rrn_enc text,
  rrn_masked text not null,

  status text not null default 'received' check (status in ('received', 'paid', 'rejected')),
  paid_at timestamptz,
  purged_at timestamptz,
  admin_memo text,

  consented_at timestamptz not null,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);

comment on table public.payback_claims is
  '지원금(페이백) 신청 장부. 주민번호·계좌번호는 Edge Function이 AES-GCM으로 암호화한 뒤에만 들어온다 — 이 DB에는 복호화 키가 없다.';
comment on column public.payback_claims.amount is
  '신청자가 청구한 이용 금액(원). 3.3% 원천징수는 지급할 때 계산한다 — 세율이 바뀌면 과거 행의 뜻이 달라지므로 공제액을 저장하지 않는다.';
comment on column public.payback_claims.rrn_enc is
  'AES-GCM 암호문(base64, iv 12바이트가 앞에 붙어 있다). 키는 Edge Function 시크릿 RRN_ENCRYPTION_KEY에만 있다. null = 파기됐거나 아직 안 들어옴.';
comment on column public.payback_claims.rrn_masked is
  '생년월일 6자리 + 하이픈 + 별표 7개. 어드민 목록은 이것만 읽는다 — 목록을 그릴 때마다 복호화하면 볼 필요 없는 순간에도 평문이 생긴다.';
comment on column public.payback_claims.status is
  'received=접수(대조 전) · paid=지급완료 · rejected=반려. 파기 크론이 걸 곳이라 이 컬럼이 없으면 주민번호를 언제 지울지 정할 수 없다.';
comment on column public.payback_claims.purged_at is
  '암호문(주민번호·계좌)을 지운 시각. 행 자체는 회계 기록이라 남는다.';

create index if not exists payback_claims_by_created
  on public.payback_claims (created_at desc);
create index if not exists payback_claims_by_status
  on public.payback_claims (status);

-- 신청 페이지는 anon key를 소스에 그대로 박고 배포된다. 정책을 하나라도 열면 그 키로
-- 주민번호 암호문과 신청자 전원의 연락처를 긁어갈 수 있다. 정책 없음 = Edge Function 전용.
alter table public.payback_claims enable row level security;

-- ── 파기 ───────────────────────────────────────────────────────────────────
--
-- 반려 즉시 파기는 여기 없다 — 그건 Edge Function이 반려를 처리하는 그 자리에서 한다.
-- 크론은 '사람이 잊은 것'만 줍는다.
create extension if not exists pg_cron;

select cron.schedule(
  'payback-claims-purge',
  '41 4 * * *',
  $$
  update public.payback_claims
     set rrn_enc = null, account_enc = null, purged_at = now()
   where purged_at is null
     and (
       (status = 'paid' and paid_at < now() - interval '1 year')
       or (status = 'received' and created_at < now() - interval '1 year')
     );
  $$
);

-- ── 어드민 조회 ────────────────────────────────────────────────────────────
--
-- **암호문을 내리지 않는다.** 브라우저는 그걸 쓸 일이 없고, 안 내리면 안 새는 값이다
-- (auth.ts의 scrubDevices와 같은 태도). 복호화가 필요하면 Edge Function의 reveal을 부른다.
--
-- 비밀번호 검증은 admin_list_reservations에 위임한다 — admin_list_sms·admin_list_applications와
-- 같은 방식이라, 비밀번호가 바뀔 때 고칠 곳이 한 군데로 유지된다.
create or replace function public.admin_list_paybacks(p_password text)
returns table (
  id bigint,
  name text,
  phone text,
  email text,
  booking_no text,
  used_on date,
  amount integer,
  bank text,
  account_holder text,
  account_masked text,
  rrn_masked text,
  status text,
  paid_at timestamptz,
  purged_at timestamptz,
  admin_memo text,
  created_at timestamptz,
  notified_at timestamptz,
  has_secret boolean
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_list_reservations(p_password);
  return query
    select c.id, c.name, c.phone, c.email, c.booking_no, c.used_on, c.amount,
           c.bank, c.account_holder, c.account_masked, c.rrn_masked, c.status,
           c.paid_at, c.purged_at, c.admin_memo, c.created_at, c.notified_at,
           (c.rrn_enc is not null) as has_secret
      from payback_claims c
     order by c.created_at desc;
end;
$function$;
