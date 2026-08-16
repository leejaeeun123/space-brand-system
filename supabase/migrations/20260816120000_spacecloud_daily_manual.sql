-- 일별 수기 숫자 컬럼 — 평일 단가 · 주말 단가 · 최소 인원 · 최소 시간 · 광고비.
--
-- 스클 지표에는 "그날 우리가 어떤 조건으로 팔았나"(가격·최소조건)와 "얼마를 태웠나"(광고비)가
-- 없다. 그게 없으면 클릭·전환의 움직임을 읽어도 "왜"를 매번 기억에 의존하게 된다. 메모(자유
-- 텍스트)와 달리 이 다섯은 숫자라서, 쌓이면 광고비÷광고클릭(실측 CPC) 같은 계산의 재료가 된다.
--
-- ── 왜 sc_daily_notes에 컬럼으로 안 붙였나 ──────────────────────────────────
--
-- notes는 `note text not null` + "빈 값이면 행 삭제" 의미론으로 이미 배포·검증됐다. 숫자
-- 컬럼을 거기 붙이면 note를 nullable로 풀고 삭제 조건을 다시 짜야 한다 — 방금 검증한 걸
-- 다시 여는 것보다 별도 표가 싸다. 성격도 다르다: 메모는 사건 기록이고, 이 표는 그날의
-- 판매 조건·지출이다.
--
-- sc_daily_stats/raw의 delete-then-insert 동기화는 이 표를 모른다 — 사람만 쓴다(notes와 동일).
create table if not exists public.sc_daily_manual (
  stat_date     date not null primary key,
  weekday_price numeric,   -- 평일 단가(원/시간)
  weekend_price numeric,   -- 주말 단가(원/시간)
  min_guests    numeric,   -- 최소 인원(명)
  min_hours     numeric,   -- 최소 시간(시간, 1.5 같은 값 허용)
  ad_spend      numeric,   -- 그날 광고비(원)
  updated_at    timestamptz not null default now()
);

comment on table public.sc_daily_manual is
  '날짜별 수기 숫자 입력(판매 조건·광고비). 동기화가 절대 덮어쓰지 않는다 — 오직 admin_upsert_sc_daily_manual로만 바뀐다. 다섯 필드가 전부 null이 되면 행을 지운다.';

alter table public.sc_daily_manual enable row level security;


-- ── 쓰기 ────────────────────────────────────────────────────────────────────
--
-- RLS를 켜되 정책을 만들지 않는다(sc_daily_notes와 같은 방식) — 이 함수가 유일한 문이다.
-- 화면에서 칸 하나 고칠 때마다 그 필드 하나만 저장한다. 필드명은 문자열로 받되 화이트리스트로
-- 잠근다 — 동적 SQL 없이 CASE로만 갱신하므로 주입 여지가 없다.
create or replace function public.admin_upsert_sc_daily_manual(
  p_password  text,
  p_stat_date date,
  p_field     text,
  p_value     numeric
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_check(p_password);

  if p_field not in ('weekday_price', 'weekend_price', 'min_guests', 'min_hours', 'ad_spend') then
    raise exception '허용되지 않은 필드입니다: %', p_field;
  end if;

  -- 단가·인원·시간·광고비 어느 것도 음수가 될 수 없다. 오타(-를 잘못 누름)를 저장 전에 막는다.
  if p_value is not null and p_value < 0 then
    raise exception '음수는 저장할 수 없습니다: %', p_value;
  end if;

  insert into public.sc_daily_manual as m
    (stat_date, weekday_price, weekend_price, min_guests, min_hours, ad_spend, updated_at)
  values (
    p_stat_date,
    case when p_field = 'weekday_price' then p_value end,
    case when p_field = 'weekend_price' then p_value end,
    case when p_field = 'min_guests'    then p_value end,
    case when p_field = 'min_hours'     then p_value end,
    case when p_field = 'ad_spend'      then p_value end,
    now()
  )
  on conflict (stat_date) do update set
    weekday_price = case when p_field = 'weekday_price' then p_value else m.weekday_price end,
    weekend_price = case when p_field = 'weekend_price' then p_value else m.weekend_price end,
    min_guests    = case when p_field = 'min_guests'    then p_value else m.min_guests    end,
    min_hours     = case when p_field = 'min_hours'     then p_value else m.min_hours     end,
    ad_spend      = case when p_field = 'ad_spend'      then p_value else m.ad_spend      end,
    updated_at    = now();

  -- 다섯 필드가 전부 비면 행 자체를 지운다 — 빈 행을 남기면 '입력한 0'과 '입력 안 함'을
  -- 구분할 수 없다(notes의 빈 문자열 삭제와 같은 이유).
  delete from public.sc_daily_manual
   where stat_date = p_stat_date
     and weekday_price is null and weekend_price is null
     and min_guests is null and min_hours is null and ad_spend is null;
end;
$function$;

comment on function public.admin_upsert_sc_daily_manual(text, date, text, numeric) is
  '하루치 수기 숫자 필드 하나를 넣거나 고친다. p_value가 null이면 그 필드를 비우고, 다섯 필드가 전부 비면 행을 지운다.';


-- ── 읽기 ────────────────────────────────────────────────────────────────────
create or replace function public.admin_list_sc_daily_manual(
  p_password text,
  p_from     date default null,
  p_to       date default null
)
returns setof sc_daily_manual
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_list_reservations(p_password);
  return query
    select * from sc_daily_manual
     where (p_from is null or stat_date >= p_from)
       and (p_to   is null or stat_date <= p_to)
     order by stat_date;
end;
$function$;

comment on function public.admin_list_sc_daily_manual(text, date, date) is
  '날짜별 수기 숫자 입력 조회. 입력이 없는 날은 행 자체가 없다.';
