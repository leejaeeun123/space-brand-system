-- 인가 판정을 평문 비교에서 `admin_check()` 해시 검증으로 옮긴다.
--
-- ⚠️ **이 파일을 push 하기 전에 비밀번호를 심어야 한다.** 안 심고 push 하면 어드민이
--    통째로 잠긴다. 절차는 `20260813110000_admin_secret.sql` 머리말에 있다.
--
-- **두 함수만 고치면 열 함수가 덮인다.** 나머지 아홉(`admin_fill_contact`·`admin_set_time`·
-- `admin_set_phone`·`admin_set_deposit`·`admin_list_sms`·`admin_list_applications`·
-- `admin_list_paybacks`·`admin_list_application_sms`)은 전부
-- `perform public.admin_list_reservations(p_password)`로 검증을 위임하고 있어서,
-- 그 뿌리 하나가 해시로 바뀌면 같이 바뀐다. 아홉 개를 각각 건드리지 않는 이유는
-- 손댈 이유 없는 함수를 라이브에서 다시 만들 때마다 위험만 늘기 때문이다.

-- ── 1. 자체 평문 검사를 갖고 있던 유일한 함수 ──────────────────────────────
--
-- 원본(20260803000000)은 `if p_password <> '1231001010'`로 값을 파일에 박아 두었다.
-- 본문의 나머지(시그니처·업데이트·반환)는 그대로 두고 검사만 바꾼다.
create or replace function public.admin_set_cancelled(p_password text, p_id uuid, p_value boolean)
returns reservations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r reservations;
begin
  perform public.admin_check(p_password);
  update reservations set cancelled = p_value where id = p_id returning * into r;
  return r;
end;
$function$;

-- ── 2. 아홉 함수가 위임하는 인가 뿌리 ──────────────────────────────────────
--
-- ⚠️ **이 함수의 정의는 원래 레포에 없었다** — 마이그레이션 이전에 DB에서 직접 만들어져
--    라이브에만 존재했고, 그래서 리뷰도 버전 관리도 받지 못했다. 여기서 레포로 회수한다.
--
-- 반환 형태는 **바꾸지 않는다**(`returns setof reservations`). 20260808100000의 결정
-- ("admin_list_reservations는 손대지 않는다 — 반환 형태를 바꾸면 어드민 전체가 위험해진다")이
-- 지키려던 것이 바로 이 형태다. 여기서 바꾸는 것은 비밀번호 검사 한 줄뿐이고, 행 타입이
-- 그대로라 새 컬럼이 자동으로 실려 나가는 성질도 유지된다.
--
-- 정렬을 걸지 않는 것도 의도다 — `admin.html`이 받아서 직접 정렬한다
-- (`.sort(function(a,b){ return a.start.localeCompare(b.start); })`). 여기서 순서를 정하면
-- 클라이언트 정렬과 이중이 되고, 나중에 한쪽만 바뀌면 화면이 조용히 어긋난다.
-- 취소된 예약도 그대로 내린다 — 어드민 목록은 취소 건을 보여줘야 하고, 캘린더 칩에서
-- 빼는 일은 클라이언트가 한다(#7).
--
-- 만약 `create or replace`가 "cannot change return type" 으로 실패하면, 라이브 시그니처가
-- 여기 적힌 것과 다르다는 뜻이다. 그때는 마이그레이션이 통째로 롤백되므로 **아무것도 깨지지
-- 않는다** — 라이브 정의를 먼저 확인하고(아래 조회) 이 블록을 실제 시그니처에 맞춘다:
--
--   select pg_get_functiondef(oid) from pg_proc
--   where proname = 'admin_list_reservations' and pronamespace = 'public'::regnamespace;
create or replace function public.admin_list_reservations(p_password text)
returns setof reservations
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_check(p_password);
  return query select * from public.reservations;
end;
$function$;

comment on function public.admin_list_reservations(text) is
  '어드민 예약 목록. 아홉 개의 admin_* 함수가 이 함수로 비밀번호를 검증한다(perform 관용구) — 검사 로직을 여기서 바꾸면 전부 같이 바뀐다.';
