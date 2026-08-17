-- 스클 지표 적재 전용 키 — 어드민 비밀번호를 서드파티 페이지에서 꺼낸다.
--
-- **왜 필요한가.** 지표 수집(`run-stats-sync.mjs`)은 partner.spacecloud.kr 탭의 JS 컨텍스트에
-- 수집기와 자격증명을 주입해 돌아간다(그 페이지의 세션을 빌려야 해서 — automation/README.md).
-- 지금 그 자격증명이 **어드민 비밀번호**다. 그 값은 예약자 이름·연락처를 여는 `admin_*` RPC
-- 전체의 열쇠라(CLAUDE.md), 우리가 통제하지 않는 페이지에 넣을 값이 아니다 — 그 페이지에
-- 악성 스크립트가 하나라도 실리면(광고 태그·공급망 침해) fetch 후킹으로 가로챌 수 있다.
--
-- 그래서 **sc_daily 적재에만 유효한 별도 키**를 만든다. 이 키로 할 수 있는 일은
-- `admin_upsert_sc_daily` 하나 — 유출돼도 피해가 지표 오염(같은 날짜 재수집으로 복구 가능)에
-- 그치고, 예약자 개인정보는 열리지 않는다.
--
-- **이 파일은 잠금 구간을 만들지 않는다**(20260813110000과 같은 3단계 규율).
-- 키를 심기 전에는 `stats_check`가 '미설정' 예외를 던지고, `stats_or_admin_check`가 그걸
-- 받아 `admin_check`로 넘어간다 — 기존 어드민 비밀번호 경로가 그대로 작동한다.
--
-- ────────────────────────────────────────────────────────────────────────
-- 적용 순서
--   1) 이 파일을 push 한다.            → 아직 아무것도 안 바뀐다 (어드민 비밀번호 계속 통함)
--   2) 키를 만들어 심는다:
--        openssl rand -hex 32          # 키 생성 — 사람이 외울 값이 아니므로 길게
--        select public.stats_set_key('<어드민 비밀번호>', '<생성한 키>');
--   3) 현장 맥의 실행 환경변수를 TL_ADMIN_PASSWORD → TL_STATS_KEY 로 바꾼다
--      (절차: automation/README.md "수집 자격증명" 절)
--
-- ⚠️ 이 키는 어드민 비밀번호 회전 세 자리(control-setup.md M절)와 **무관하다.**
--    어드민을 회전해도 이 키는 그대로 살고, 이 키를 회전해도 어드민은 안 움직인다 —
--    독립 키라 네 번째 자리가 생기는 게 아니다. 회전은 2)단계를 다시 실행하면 된다.
-- ────────────────────────────────────────────────────────────────────────

create table if not exists public.stats_secret (
  id int primary key default 1 check (id = 1),
  key_hash text not null,
  rotated_at timestamptz not null default now()
);

comment on table public.stats_secret is
  '스클 지표 적재 전용 키의 bcrypt 해시. 행은 하나뿐이다(id=1). 어드민 비밀번호와 독립 — 회전 세 자리에 포함되지 않는다.';

-- RLS on + 정책 없음 = service_role만. anon 키로는 해시조차 못 읽는다(admin_secret과 같은 태도).
alter table public.stats_secret enable row level security;

/**
 * stats 키가 맞으면 조용히 통과, 틀리면 예외 — `admin_check`(20260814150000)의 거울이다.
 *
 * 시도 제한도 같은 장부(auth_attempts)를 쓰되 fn='stats_rpc'로 따로 센다 — 이 키를 향한
 * 브루트포스가 어드민 쪽 카운터를 태우면 안 되고, 그 반대도 마찬가지다.
 *
 * '미설정'을 별도 문구로 던지는 것도 같은 이유다(20260813110000) — 키를 아직 안 심은
 * 상태가 '누구나 통과'로 해석되면 안 되고, 'invalid'로 뭉개면 원인을 못 찾는다.
 */
-- ⚠️ `search_path`에 스키마를 **두 개 이상** 줄 땐 따옴표로 묶지 않는다(20260813110000 실측).
create or replace function public.stats_check(p_key text)
returns void
language plpgsql
security definer
set search_path to public, extensions
as $function$
declare
  stored text;
  v_ip text;
  v_fails int := 0;
begin
  -- PostgREST가 아닌 경로는 request.headers가 없다 → 제한을 건너뛴다(admin_check와 동일).
  begin
    v_ip := nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip';
  exception when others then
    v_ip := null;
  end;

  if v_ip is not null then
    -- fail-open: 장부 조회 실패가 수집 전면 중단이 되면 안 된다(_shared/throttle.ts와 같은 태도).
    begin
      select count(*) into v_fails
        from public.auth_attempts
       where ip = v_ip
         and fn = 'stats_rpc'
         and at > now() - interval '10 minutes';
    exception when others then
      v_fails := 0;
    end;

    if v_fails >= 10 then
      raise exception 'too many attempts';
    end if;
  end if;

  select key_hash into stored from public.stats_secret where id = 1;

  if stored is null then
    raise exception 'stats_secret 미설정 — 키를 심어야 합니다(20260818020000 주석 참조)';
  end if;

  if crypt(p_key, stored) <> stored then
    if v_ip is not null then
      -- 실패만 센다. 기록 실패가 인증 결과를 오염시키면 안 된다(admin_check와 동일).
      begin
        insert into public.auth_attempts (ip, fn) values (v_ip, 'stats_rpc');
      exception when others then
        null;
      end;
    end if;
    raise exception 'invalid stats key';
  end if;
end;
$function$;

comment on function public.stats_check(text) is
  '스클 지표 적재 키 검증. 맞으면 통과, 틀리거나 미설정이면 예외. 실패는 IP당 10분/10회로 제한(fn=stats_rpc).';

/**
 * stats 키 **또는** 어드민 비밀번호 — `admin_upsert_sc_daily`의 관문.
 *
 * 순서가 의도다: **stats 키를 먼저** 본다. 반대로 하면 정상적인 키 기반 수집이 매번
 * admin_check에서 한 번 실패하고, 그 실패가 어드민 시도 제한 장부(fn='rpc')에 쌓여
 * 열 번째 수집부터 같은 IP의 어드민 화면이 잠긴다.
 *
 * 어드민 비밀번호도 계속 받는 이유는 잠금 구간을 없애기 위해서다 — 키를 심기 전(미설정)에도,
 * 키를 잃어버린 날에도 어드민 비밀번호로 적재가 된다. 어드민 비밀번호는 이 함수의 상위
 * 권한이므로 받는다고 권한이 넓어지지 않는다.
 */
create or replace function public.stats_or_admin_check(p_credential text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    perform public.stats_check(p_credential);
    return;
  exception when others then
    null;  -- 미설정·불일치·시도 제한 전부 어드민 경로로 넘긴다
  end;
  perform public.admin_check(p_credential);
end;
$function$;

comment on function public.stats_or_admin_check(text) is
  'stats 키(우선) 또는 어드민 비밀번호를 받는다. sc_daily 적재 전용 관문 — 다른 admin_* RPC에 쓰지 않는다.';

/**
 * stats 키를 심는다(회전 포함). 어드민 비밀번호로만 부를 수 있다.
 *
 * 32자 하한은 사람 편의와 무관하다 — 이 키는 사람이 외우는 값이 아니라 `openssl rand -hex 32`로
 * 만드는 값이고, 짧은 키를 허용할 이유가 없다(어드민 비밀번호의 최소 길이를 없앤 20260817000000과
 * 반대 방향인 것이 맞다 — 그쪽은 사람이 입력하는 값이라 강제하지 않기로 한 것이다).
 *
 * ⚠️ 이 호출은 SQL 편집기 기록·psql 히스토리에 평문으로 남는다(admin_set_password와 같음).
 *    심은 뒤 히스토리를 지우거나, 기록이 남지 않는 경로로 실행한다.
 */
create or replace function public.stats_set_key(p_password text, p_key text)
returns void
language plpgsql
security definer
set search_path to public, extensions
as $function$
begin
  perform public.admin_check(p_password);

  if p_key is null or length(p_key) < 32 then
    raise exception 'stats 키는 32자 이상이어야 합니다 — openssl rand -hex 32 로 만드세요';
  end if;

  insert into public.stats_secret (id, key_hash)
  values (1, crypt(p_key, gen_salt('bf', 12)))
  on conflict (id) do update set key_hash = excluded.key_hash, rotated_at = now();
end;
$function$;

comment on function public.stats_set_key(text, text) is
  'stats 적재 키를 심는다(회전 포함). 어드민 비밀번호 필요. 절차는 automation/README.md "수집 자격증명" 절.';

-- ── 적재 함수의 관문 교체 ─────────────────────────────────────────────────
--
-- 본문은 20260816000000과 같고 **첫 줄의 검증만** stats_or_admin_check로 바뀐다.
-- 읽기(admin_list_sc_daily 등)와 수기 입력(admin_upsert_sc_daily_note·manual)은 그대로
-- 어드민 전용이다 — 스클 페이지에서 부를 일이 없는 함수에 키를 열어줄 이유가 없다.
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
  perform public.stats_or_admin_check(p_password);

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
  '스클 일별 지표 + 응답 원문을 덮어쓴다. p_password는 stats 키(우선) 또는 어드민 비밀번호 — 수집기는 키만 쓴다(20260818020000).';
