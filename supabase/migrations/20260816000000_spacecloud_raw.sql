-- 스클 API 응답 원문 보관 — 우리가 고른 것만 남기지 않는다.
--
-- `sc_daily_stats`(20260815000000)는 **해석한 표**다. 컬럼을 33개 골라 담았고, 그 과정에서
-- 일부러 버린 것이 있다:
--
--   · 비율 전부(qa_response_rate · review_response_rate · reservation_approve_rate ·
--     reservation_cancel_rate · guest/host cancel rate · re_reservation_rate)
--   · review_score_avg 같은 파생값
--   · 앞으로 스클이 추가할, 지금은 이름도 모르는 필드
--
-- 버린 이유는 그때도 맞았다(기간 비율은 일별 비율의 평균이 아니라 저장하면 오용된다).
-- 그런데 **버린 것을 되찾을 방법이 없다는 게 문제**다. 스클 API는 지난 날짜를 계속 주므로
-- 지금은 다시 받으면 되지만, 그 보장이 영원하지 않고 리스팅이 내려가면 과거도 같이 사라진다.
-- 파싱을 잘못했다는 걸 나중에 알아차렸을 때 되돌릴 자리가 여기다.
--
-- ── 설계 셋 ─────────────────────────────────────────────────────────────────
--
--  1) **해석하지 않는다.** 받은 JSON을 그대로 넣는다. 키 이름도 스클 것을 쓴다
--     (`show_data`가 사실은 클릭수라는 헷갈림까지 원문 그대로 남긴다 — 여기서 고쳐 쓰면
--     '원문 보관'이라는 이 표의 유일한 쓸모가 사라진다).
--
--  2) **표가 둘로 나뉜 이유.** 대시보드는 `sc_daily_stats`만 읽는다. 원문을 같은 표에
--     jsonb 컬럼으로 붙이면 조회할 때마다 안 쓰는 수십 KB가 따라온다. 원문은 사고가
--     났을 때만 읽는 자료라 따로 둔다.
--
--  3) **차트는 그 날 몫만 잘라 담는다.** `/partner/statistics`는 구간 응답이라 그대로 넣으면
--     하루 행에 남의 날짜가 섞인다. 그래서 시리즈별로 그 날 값만 뽑아
--     `{"impression_data":{"전체":812,"일반":700,...}, ...}` 형태로 재구성한다 — 값 자체는
--     손대지 않으니 원문성은 유지되고, 하루가 원자라는 원칙도 지켜진다.
--     지표(`/partner/host_stat_indicators`)는 애초에 하루 단위로 부르므로 응답 통째로 들어간다.

create table if not exists public.sc_daily_raw (
  space_id   integer not null,
  stat_date  date    not null,

  -- host_stat_indicators 응답 전체(비율·search_word_data 포함). 하루로 조회한 그대로다.
  indicators jsonb not null,

  -- statistics 12개 시리즈에서 그 날 값만 뽑은 것. 시리즈명·데이터셋명은 스클 원문.
  chart      jsonb not null,

  collected_at timestamptz not null default now(),

  primary key (space_id, stat_date)
);

comment on table public.sc_daily_raw is
  '스클 API 응답 원문(일별). 해석하지 않는다 — sc_daily_stats가 버린 비율·파생값·미래 필드를 되찾을 유일한 자리.';
comment on column public.sc_daily_raw.indicators is
  'host_stat_indicators 응답 전체. sc_daily_stats에 없는 *_rate 계열과 review_score_avg가 여기 살아 있다.';
comment on column public.sc_daily_raw.chart is
  'statistics 응답에서 그 날 값만 시리즈별로 뽑은 것. 키는 스클 원문 그대로라 show_data가 클릭수인 것도 그대로다(고쳐 쓰면 원문 보관의 의미가 없다).';

alter table public.sc_daily_raw enable row level security;


-- ── 쓰기 ────────────────────────────────────────────────────────────────────
--
-- 기존 3인자 함수를 **지우고** 4인자로 다시 만든다. 기본값을 준 채 두 개를 공존시키면
-- 3인자 호출이 어느 쪽인지 모호해져 PostgREST가 거부한다. 수집기가 같은 변경에서 함께
-- 바뀌므로 옛 시그니처를 남길 이유가 없다.
drop function if exists public.admin_upsert_sc_daily(text, jsonb, jsonb);

create or replace function public.admin_upsert_sc_daily(
  p_password text,
  p_stats    jsonb,
  p_keywords jsonb,
  p_raw      jsonb default null
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_days date[];
  v_space integer;
  v_spaces integer;
  v_written integer;
begin
  perform public.admin_check(p_password);

  if p_stats is null or jsonb_typeof(p_stats) <> 'array' then
    raise exception 'p_stats 는 배열이어야 합니다';
  end if;

  if jsonb_array_length(p_stats) = 0 then
    return 0;
  end if;

  select array_agg(distinct (e ->> 'stat_date')::date),
         count(distinct (e ->> 'space_id')::integer)
    into v_days, v_spaces
    from jsonb_array_elements(p_stats) e;

  if v_spaces <> 1 then
    raise exception '한 번에 한 공간만 넣을 수 있습니다 (받은 공간 수: %)', v_spaces;
  end if;

  select (e ->> 'space_id')::integer into v_space
    from jsonb_array_elements(p_stats) e limit 1;

  -- D-0 방어(20260815000000 설계 5). 기준 시각은 한국시간이다 — DB가 UTC라 current_date를
  -- 쓰면 한국시간 00~09시에 멀쩡한 어제가 거부된다.
  if exists (
    select 1 from unnest(v_days) d
     where d >= (now() at time zone 'Asia/Seoul')::date
  ) then
    raise exception '오늘(D-0) 이후 날짜는 넣을 수 없습니다 — 스클 지표는 어제까지만 확정됩니다';
  end if;

  delete from public.sc_daily_stats
   where space_id = v_space and stat_date = any(v_days);
  delete from public.sc_daily_keywords
   where space_id = v_space and stat_date = any(v_days);

  insert into public.sc_daily_stats
  select (jsonb_populate_record(
            null::public.sc_daily_stats,
            e || jsonb_build_object('collected_at', now())
          )).*
    from jsonb_array_elements(p_stats) e;

  get diagnostics v_written = row_count;

  if p_keywords is not null and jsonb_typeof(p_keywords) = 'array'
     and jsonb_array_length(p_keywords) > 0 then
    insert into public.sc_daily_keywords
    select (jsonb_populate_record(null::public.sc_daily_keywords, e)).*
      from jsonb_array_elements(p_keywords) e;
  end if;

  -- 원문은 **없어도 통과시킨다.** 원문 저장이 실패해 그날 지표까지 안 들어가면 본말이
  -- 전도된다. 옛 수집기가 4번째 인자 없이 부르는 경우도 여기로 떨어진다.
  if p_raw is not null and jsonb_typeof(p_raw) = 'array'
     and jsonb_array_length(p_raw) > 0 then
    delete from public.sc_daily_raw
     where space_id = v_space and stat_date = any(v_days);

    insert into public.sc_daily_raw (space_id, stat_date, indicators, chart, collected_at)
    select (e ->> 'space_id')::integer,
           (e ->> 'stat_date')::date,
           e -> 'indicators',
           e -> 'chart',
           now()
      from jsonb_array_elements(p_raw) e
     where e ? 'indicators' and e ? 'chart';
  end if;

  return v_written;
end;
$function$;

comment on function public.admin_upsert_sc_daily(text, jsonb, jsonb, jsonb) is
  '스클 일별 지표 + 응답 원문을 덮어쓴다. 받은 날짜만 갈아끼우므로 재수집이 몇 번이든 안전하다. p_raw는 선택 — 없어도 지표는 들어간다.';


-- ── 읽기 ────────────────────────────────────────────────────────────────────
--
-- 원문은 대시보드가 늘 읽는 게 아니라 **따져볼 일이 있을 때** 읽는다. 그래서 범위를
-- 강제하지 않되(전체 조회 허용) 기본은 날짜순이다.
create or replace function public.admin_list_sc_raw(
  p_password text,
  p_from     date default null,
  p_to       date default null
)
returns setof sc_daily_raw
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_list_reservations(p_password);
  return query
    select * from sc_daily_raw
     where (p_from is null or stat_date >= p_from)
       and (p_to   is null or stat_date <= p_to)
     order by stat_date;
end;
$function$;

comment on function public.admin_list_sc_raw(text, date, date) is
  '스클 응답 원문 조회. 해석된 표(sc_daily_stats)와 어긋나 보일 때 대조하는 용도.';
