-- 일별 수기 메모 — 가격 변경·쿠폰 발행·광고 집행처럼 숫자만 봐서는 알 수 없는 "왜"를
-- 사람이 직접 남기는 자리다.
--
-- ── 왜 sc_daily_stats에 컬럼으로 안 붙였나 ──────────────────────────────────
--
-- `admin_upsert_sc_daily`(20260815000000)는 받은 날짜 범위를 **delete 후 insert로 통째로
-- 갈아끼운다** — 스클 지표가 나중에 보정되므로 수집기가 최근 구간을 반복해서 다시 받아
-- 덮어쓰는 게 전제다(설계 그대로). 메모를 그 표 컬럼으로 두면 다음 수집 때 조용히
-- 지워진다. sc_daily_raw도 같은 delete-then-insert라 마찬가지다. 그래서 동기화가
-- 절대 건드리지 않는 별도 표가 필요하다 — 이 표는 어떤 수집기도 쓰지 않는다, 사람만 쓴다.
--
-- ── space_id를 안 넣은 이유 ──────────────────────────────────────────────────
--
-- sc_daily_stats/keywords/raw는 (space_id, stat_date) 복합키지만, 실제로 이 공간은 하나뿐이고
-- (spacecloud-stats-sync.js의 SPACE_ID=80401 하나) admin_list_sc_daily/keywords/raw 중
-- 어느 것도 space_id로 걸러 읽지 않는다 — 즉 기존 표에서도 실질적으로 안 쓰이는 컬럼이다.
-- 안 쓰이는 필드를 메모 표에 새로 들이는 대신 stat_date 단일키로 둔다. 공간이 늘어나는
-- 날이 오면 그때 이 표 전체를 다시 설계하는 게 맞다 — 그때 가서 저장 형태도 같이 정해야
-- 한다(메모가 공간별인지 전체 운영 공통인지부터 다시 물어야 한다).
create table if not exists public.sc_daily_notes (
  stat_date  date not null primary key,
  note       text not null,
  updated_at timestamptz not null default now()
);

comment on table public.sc_daily_notes is
  '날짜별 수기 메모(가격 변경·쿠폰 발행·광고 집행 등). sc_daily_stats/raw와 달리 동기화가 절대 덮어쓰지 않는다 — 오직 admin_upsert_sc_daily_note로만 바뀐다.';
comment on column public.sc_daily_notes.note is
  '자유 텍스트, 빈 값 없음. 공백만 남기면 admin_upsert_sc_daily_note가 그 행을 지운다.';

alter table public.sc_daily_notes enable row level security;


-- ── 쓰기 ────────────────────────────────────────────────────────────────────
--
-- RLS를 켜되 정책을 만들지 않는다(sc_daily_stats·support_applications와 같은 방식) — 이
-- 함수가 유일한 문이다. 한 번에 하루치만 받는다(스클 지표처럼 배치로 몰아넣을 일이 없다 —
-- 사람이 화면에서 칸 하나씩 고친다).
create or replace function public.admin_upsert_sc_daily_note(
  p_password  text,
  p_stat_date date,
  p_note      text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_check(p_password);

  -- 빈 문자열/공백은 '메모 없음'이다. 빈 행을 남겨두면 화면에 빈 입력칸과 실제로 메모가
  -- 없는 날을 구분할 수 없다 — 지우는 게 맞다.
  if p_note is null or btrim(p_note) = '' then
    delete from public.sc_daily_notes where stat_date = p_stat_date;
    return;
  end if;

  insert into public.sc_daily_notes (stat_date, note, updated_at)
  values (p_stat_date, btrim(p_note), now())
  on conflict (stat_date) do update
    set note = excluded.note, updated_at = excluded.updated_at;
end;
$function$;

comment on function public.admin_upsert_sc_daily_note(text, date, text) is
  '하루치 수기 메모를 넣거나 고친다. 빈 문자열/공백을 주면 그 날짜 메모를 지운다.';


-- ── 읽기 ────────────────────────────────────────────────────────────────────
create or replace function public.admin_list_sc_daily_notes(
  p_password text,
  p_from     date default null,
  p_to       date default null
)
returns setof sc_daily_notes
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_list_reservations(p_password);
  return query
    select * from sc_daily_notes
     where (p_from is null or stat_date >= p_from)
       and (p_to   is null or stat_date <= p_to)
     order by stat_date;
end;
$function$;

comment on function public.admin_list_sc_daily_notes(text, date, date) is
  '날짜별 수기 메모 조회. 메모가 없는 날은 행 자체가 없다(빈 문자열 행을 만들지 않는다).';
