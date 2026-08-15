-- 스페이스클라우드 운영지표 원장 — 대시보드가 읽을 유일한 사실.
--
-- 파트너 콘솔(`partner.spacecloud.kr/report/statistics`)이 그리는 그래프의 원천은 두 API다.
-- 화면은 캔버스라 긁을 수 없고, 애초에 긁을 필요도 없었다:
--
--   GET api.spacecloud.kr/partner/statistics?start_date&end_date&space_id&type
--       -> Chart.js 형태 { labels:["07.22",...], datasets:[{label,data:[...]}] } 12종
--   GET api.spacecloud.kr/partner/host_stat_indicators?...
--       -> 기간 집계 스칼라 25종 + search_word_data(유입 키워드 TOP5)
--
-- 둘 다 `Authorization: Bearer <파트너 토큰>`을 받는다. 수집기는
-- `06-applications/automation/spacecloud-stats-sync.js`이고, 왜 브라우저에서 도는지는
-- 그 파일과 automation/README.md에 있다.
--
-- ── 설계 다섯, 되돌리기 전에 읽을 것 ──────────────────────────────────────────
--
--  1) **하루가 원자다.** `host_stat_indicators`는 start_date=end_date로 부르면 그 하루치만
--     준다(실측). 그래서 일별로 모아두면 주·월·임의 구간을 우리가 다시 합칠 수 있다.
--     반대로 기간으로 모아두면 절대 쪼갤 수 없다. 2026-08-15 전수 대조에서 13개 지표 중
--     12개가 **일별 합 == 기간 조회값**으로 정확히 일치했다(게스트 78·확정 28건·985,800원 등).
--
--  2) **`re_reservation_count`만 가산되지 않는다.** 같은 대조에서 일별 합 20 ≠ 기간값 22였다.
--     재예약 판정이 '조회 구간 안에 이전 이용이 있었나'라서, 하루 창으로 자르면 그 이전을
--     못 본다. **이 컬럼을 SUM 하면 틀린다** — 기간 재예약률이 필요하면 그 기간으로 API를
--     다시 부른다. 원본이 준 값이라 raw로 남기되, 쓰는 쪽이 반드시 알아야 하는 함정이다.
--
--  3) **비율(응답률·승인율·취소율)은 저장하지 않는다.** API가 일별 비율도 주지만 저장하면
--     반드시 잘못 쓰인다 — 기간 비율은 일별 비율의 평균이 아니다. 게다가 2026-08-14 실측에서
--     `reservation_approve_count = 0`인데 `reservation_approve_rate = 100`이었다(즉시예약이라
--     분모가 0인데 100%로 표시). 분모를 이 표의 카운트로 복원할 수 없다는 뜻이라, 비율은
--     화면에서 그때그때 계산하고 0 나눗셈을 막는 편이 안전하다.
--
--  4) **확정 수치가 두 벌인데 둘 다 맞다.** 차트(`rsv_*`)는 **총액(gross)**이고 지표
--     (`reservation_*`)는 **순액(net)**이다. 기간 전체로는 정확히 맞아떨어진다 —
--     1,345,800(확정) − 360,000(취소) = 985,800(지표). 그런데 **일별로는 24일 중 4일이
--     어긋난다**: A일에 확정된 예약이 B일에 취소되면 두 사건이 서로 다른 날에 찍히기 때문이다.
--     그래서 **일 단위 순매출은 계산할 수 없다.** 두 벌 다 저장하는 이유가 이것이다.
--
--  5) **오늘(D-0)은 절대 쓰지 않는다.** 콘솔도 "어제(D-1) 기준"이라 적어두었고, 오늘 날짜로
--     부르면 에러가 아니라 **말끔한 0**이 돌아온다(2026-08-15 실측: labels=[] · 전 지표 0).
--     그 0을 그대로 넣으면 '장사가 안 된 날'과 구분되지 않는다. 수집기가 어제까지만 쓰도록
--     막고 있고, 이 표에도 체크 제약으로 한 번 더 건다.

create table if not exists public.sc_daily_stats (
  space_id  integer not null,
  stat_date date    not null,

  -- ── host_stat_indicators (하루 단위 조회) ─────────────────────────────────
  usedc_guest_count             integer not null,
  reservation_usedc_count       integer not null,
  reservation_confirm_count     integer not null,
  reservation_amount            bigint  not null,
  reservation_total_count       integer not null,
  re_reservation_count          integer not null,
  qa_count                      integer not null,
  qa_answer_complete_count      integer not null,
  review_count                  integer not null,
  review_answer_complete_count  integer not null,
  zzim_count                    integer not null,
  review_score_sum              integer not null,
  reservation_approve_count     integer not null,
  reservation_cancel_count      integer not null,
  reservation_guest_cancel_count integer not null,
  reservation_host_cancel_count  integer not null,

  -- ── statistics 차트 중 지표에 없는 것만 ───────────────────────────────────
  -- QnA·후기·찜 차트는 위 지표와 일별로 완전히 같은 값이라(2026-08-15 24일 전수 대조)
  -- 컬럼을 만들지 않았다. 같은 수를 두 벌 두면 언젠가 한쪽만 갱신된다.
  impression_total  integer not null,
  impression_normal integer not null,
  impression_ad     integer not null,
  impression_etc    integer not null,
  click_total       integer not null,
  click_normal      integer not null,
  click_ad          integer not null,
  click_etc         integer not null,

  rsv_confirm_count  integer not null,
  rsv_usedc_count    integer not null,
  rsv_cancel_count   integer not null,
  rsv_confirm_amount bigint  not null,
  rsv_usedc_amount   bigint  not null,
  rsv_cancel_amount  bigint  not null,

  call_total   integer not null,
  call_success integer not null,
  call_fail    integer not null,

  collected_at timestamptz not null default now(),

  primary key (space_id, stat_date)
  -- D-0 방어는 여기가 아니라 admin_upsert_sc_daily 안에 있다. CHECK 제약으로 쓰면
  -- `current_date`가 DB의 UTC 날짜라, **한국시간 00~09시 사이에는 어제(KST)와 오늘(UTC)이
  -- 같은 날짜**가 되어 멀쩡한 어제 데이터가 거부된다. 그 시간대에만 실패하는 방어는
  -- 방어가 아니라 시한폭탄이라, 시간대를 명시할 수 있는 함수 쪽으로 옮겼다.
);

comment on table public.sc_daily_stats is
  '스페이스클라우드 파트너 운영지표 일별 원장. 하루가 원자 — 주/월은 여기서 다시 합친다. 단 re_reservation_count는 가산 불가.';
comment on column public.sc_daily_stats.re_reservation_count is
  '⚠️ SUM 금지. 재예약 판정이 조회 구간에 의존해 일별 합이 기간 조회값과 다르다(실측 20 vs 22). 기간 재예약수는 API를 그 기간으로 다시 부른다.';
comment on column public.sc_daily_stats.reservation_amount is
  '확정 예약금액 — 순액(취소분이 이미 빠진 값). 콘솔 상단 "확정 예약금액"이 이 값이다. 총액은 rsv_confirm_amount.';
comment on column public.sc_daily_stats.reservation_confirm_count is
  '확정 예약수 — 순액 기준. 콘솔 상단 "확정 예약수". 총액 기준은 rsv_confirm_count.';
comment on column public.sc_daily_stats.rsv_confirm_amount is
  '차트 "예약확정" 금액 — 총액(gross). 나중에 취소된 건도 포함한다. 일별로 rsv_confirm_amount - rsv_cancel_amount != reservation_amount 인 날이 있다(확정일과 취소일이 다른 예약). 기간 합으로만 일치한다.';
comment on column public.sc_daily_stats.impression_total is
  '도달수(노출) 전체 = 일반+광고+기타. API 키는 impression_data.';
comment on column public.sc_daily_stats.click_total is
  '클릭수 전체 = 일반+광고+기타. ⚠️ API 키가 click_data 가 아니라 **show_data** 다. impression_data(도달)와 헷갈리기 쉽다 — 2026-08-15 기준 도달 20,262 대 클릭 1,325 로 자릿수가 다르다.';
comment on column public.sc_daily_stats.collected_at is
  '이 행을 마지막으로 채운 시각. 스클 지표는 실시간이 아니고 나중에 보정되므로, 수집기는 최근 구간을 다시 받아 덮어쓴다.';

create index if not exists sc_daily_stats_by_date
  on public.sc_daily_stats (stat_date desc);

alter table public.sc_daily_stats enable row level security;


-- ── 유입 키워드 ─────────────────────────────────────────────────────────────
--
-- `search_word_data`는 하루 단위로도 온다(실측). 다만 저장되는 값이 **건수가 아니라 비율(%)** 이다.
-- 2026-08-15 24일 전수 확인: 키워드가 적은 날은 합이 정확히 100이고(07-22 57+43, 07-24 단일 100),
-- 많은 날은 73~94에 그친다 — **상위 5개에서 잘린 나머지가 빠져 있기 때문**이다. 마지막 칸의
-- "기타"조차 남은 전부가 아니라 5위 자리에 들어온 한 덩어리다(08-03: 합계 73, 기타는 5).
--
-- 그래서 이 표는 두 가지를 **할 수 없다**:
--   · 여러 날의 값을 더해 기간 상위를 구하는 것 — 매일 잘리는 대상이 달라 순위가 뒤집힌다.
--   · 값을 건수처럼 쓰는 것 — 유입이 5건인 날의 100%와 500건인 날의 50%가 같아 보인다.
-- 기간 상위 키워드가 필요하면 그 기간으로 API를 다시 부른다(재예약수와 같은 성질).
-- 굳이 일별에서 근사하려면 그 날의 click_total로 가중해야 한다.
create table if not exists public.sc_daily_keywords (
  space_id  integer  not null,
  stat_date date     not null,
  rank      smallint not null,
  keyword   text     not null,
  share_pct smallint not null,

  primary key (space_id, stat_date, rank)
);

comment on table public.sc_daily_keywords is
  '일별 유입 키워드 TOP5. 값은 건수가 아니라 비율(%)이고 상위 5개에서 잘린다 — 날짜를 합쳐 기간 상위를 구하면 틀린다.';
comment on column public.sc_daily_keywords.keyword is
  '검색어 원문. 마지막 순위에 오는 "기타"는 실제 검색어가 아니라 스클이 묶은 덩어리이고, 남은 전부도 아니다.';
comment on column public.sc_daily_keywords.share_pct is
  '그 날 검색 유입에서 차지한 비율(%). ⚠️ 건수가 아니다. 상위 5개만 오므로 하루 합이 100에 못 미친다(실측 73~101). 날짜 간 비교는 click_total로 가중해야 뜻이 있다.';

alter table public.sc_daily_keywords enable row level security;


-- ── 쓰기 ────────────────────────────────────────────────────────────────────
--
-- RLS를 켜되 정책을 만들지 않는다(support_applications와 같은 방식) — 수집기는 anon 키로
-- 붙으므로, 정책을 열면 누구나 남의 공간 지표를 넣거나 지울 수 있다. 이 함수가 유일한 문이다.
--
-- **덮어쓴다(delete 후 insert).** 스클 지표는 실시간이 아니고 나중에 보정된다고 콘솔이
-- 명시하므로, 먼저 본 값을 고정하는 insert-ignore 방식은 틀린 값을 영구히 남긴다. 수집기가
-- 매번 최근 구간을 다시 받아 통째로 갈아끼우는 전제이고, 그래서 몇 번을 돌려도 안전하다.
--
-- 컬럼 매핑은 `jsonb_populate_record`가 한다. 이름이 하나라도 틀리면 그 컬럼이 null이 되는데
-- **전 컬럼이 not null이라 조용히 통과하지 못하고 거기서 터진다** — 스클이 필드명을 바꾸면
-- 0이 쌓이는 대신 수집이 실패해서 드러난다.
create or replace function public.admin_upsert_sc_daily(
  p_password text,
  p_stats    jsonb,
  p_keywords jsonb
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

  -- 이번에 받은 (공간, 날짜)만 갈아끼운다. 창 밖의 과거 데이터는 건드리지 않는다.
  select array_agg(distinct (e ->> 'stat_date')::date),
         count(distinct (e ->> 'space_id')::integer)
    into v_days, v_spaces
    from jsonb_array_elements(p_stats) e;

  -- 한 번에 한 공간만 받는다. 섞여 들어오면 아래 delete가 **한 공간만 지우고** insert는
  -- 전부 하게 되어, 안 지워진 쪽이 기본키 충돌로 터지거나(운 좋은 경우) 조용히 어긋난다.
  -- 공간이 늘어나면 호출을 공간별로 나눈다 — 여기서 루프를 도는 것보다 그쪽이 단순하다.
  if v_spaces <> 1 then
    raise exception '한 번에 한 공간만 넣을 수 있습니다 (받은 공간 수: %)', v_spaces;
  end if;

  select (e ->> 'space_id')::integer into v_space
    from jsonb_array_elements(p_stats) e limit 1;

  -- D-0 방어(설계 5). 스클은 오늘 날짜를 물으면 에러가 아니라 말끔한 0을 준다 —
  -- 그대로 넣으면 '집계 전'과 '장사가 안 된 날'이 영영 구분되지 않는다.
  -- **기준 시각은 한국시간이다.** DB는 UTC라 `current_date`를 쓰면 한국시간 00~09시에
  -- 어제가 오늘로 보여 정상 수집이 거부된다.
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

  return v_written;
end;
$function$;

comment on function public.admin_upsert_sc_daily(text, jsonb, jsonb) is
  '스클 일별 지표를 덮어쓴다. 받은 날짜만 갈아끼우므로 재수집이 몇 번이든 안전하다. 수집기는 06-applications/automation/spacecloud-stats-sync.js.';


-- ── 읽기 ────────────────────────────────────────────────────────────────────
--
-- 비밀번호 검증을 admin_list_reservations에 위임하는 것은 admin_list_applications와 같은
-- 이유다 — 검사 로직을 한 뿌리(admin_check)에만 두기 위해서.
--
-- `returns setof`인 것도 같은 이유다. 스클이 지표를 추가해 컬럼이 붙어도 자동으로 실려 나간다.
create or replace function public.admin_list_sc_daily(
  p_password text,
  p_from     date default null,
  p_to       date default null
)
returns setof sc_daily_stats
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_list_reservations(p_password);
  return query
    select * from sc_daily_stats
     where (p_from is null or stat_date >= p_from)
       and (p_to   is null or stat_date <= p_to)
     order by stat_date;
end;
$function$;

comment on function public.admin_list_sc_daily(text, date, date) is
  '스클 일별 지표 조회. 날짜 오름차순 — 그래프가 그대로 그린다. 범위를 비우면 전체.';

create or replace function public.admin_list_sc_keywords(
  p_password text,
  p_from     date default null,
  p_to       date default null
)
returns setof sc_daily_keywords
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_list_reservations(p_password);
  return query
    select * from sc_daily_keywords
     where (p_from is null or stat_date >= p_from)
       and (p_to   is null or stat_date <= p_to)
     order by stat_date, rank;
end;
$function$;

comment on function public.admin_list_sc_keywords(text, date, date) is
  '일별 유입 키워드 조회. ⚠️ share_pct는 건수가 아니라 비율이고 매일 TOP5로 잘린다 — 여러 날을 합쳐 상위를 구하면 틀린다(테이블 주석 참조).';
