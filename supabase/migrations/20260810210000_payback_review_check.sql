-- 지원금 신청에 '리뷰 남겼는지' 확인을 추가한다.
--
-- **boolean이 아니라 시각으로 남긴다.** `consented_at`과 같은 이유다 — 확인은 "했다"가 아니라
-- "언제 했다"가 기록이어야 나중에 대조가 된다. boolean이면 나중에 값이 바뀌었을 때 언제
-- 바뀌었는지 알 수 없고, null 하나로 '안 함'과 '아직 안 물어봄'이 뭉개진다.
--
-- 캡처 이미지를 받지 않기로 한 결정이 여기 깔려 있다(형운, 2026-08-10). 이미지를 받으면
-- Storage 버킷·업로드 경로·서명 URL·그리고 **파기 대상이 하나 더** 늘어난다 — 주민번호와
-- 같은 생애주기로 지워야 하는데 SQL 크론은 Storage를 못 지운다. 신청자의 확인만 받고
-- 실제 리뷰는 사람이 판매 채널에서 대조하는 쪽이 훨씬 가볍고, 대조 정확도도 더 높다.

alter table public.payback_claims
  add column if not exists review_confirmed_at timestamptz;

comment on column public.payback_claims.review_confirmed_at is
  '신청자가 리뷰를 남겼다고 확인한 시각. null = 확인하지 않음. 서버가 접수 시각으로 찍는다 — 클라이언트가 보낸 시각을 믿지 않는다.';

-- ── 어드민 조회 함수 갱신 ───────────────────────────────────────────────────
--
-- ⚠️ `returns table(...)`은 컬럼이 하나만 늘어도 **create or replace가 통하지 않는다**
-- ("cannot change return type of existing function"). 반드시 먼저 지운다.
-- 지웠다 다시 만드는 사이에 어드민이 조회하면 잠깐 실패하는데, 마이그레이션은 트랜잭션
-- 안에서 돌아 실제로 열려 있는 창은 없다.
drop function if exists public.admin_list_paybacks(text);

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
  review_confirmed_at timestamptz,
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
           c.review_confirmed_at,
           (c.rrn_enc is not null) as has_secret
      from payback_claims c
     order by c.created_at desc;
end;
$function$;
