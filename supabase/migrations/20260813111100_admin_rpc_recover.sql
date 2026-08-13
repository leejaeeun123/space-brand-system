-- 라이브에만 있던 admin_* 함수 다섯 개를 레포로 회수하고, 검증을 admin_check 로 옮긴다.
--
-- **이걸 안 하면 비밀번호 회전이 시스템을 두 방향으로 깬다.** 2026-08-13 라이브 스키마를
-- 덤프해 전수 확인한 결과, `admin_*` 함수는 17개인데 그중 다섯이 **버전 관리 밖에 있었고
-- 옛 PIN 을 본문에 평문으로 들고 있었다**:
--   admin_add_reservation · admin_delete_reservation · admin_set_checkin ·
--   admin_set_checkout · admin_set_cleaning
--
-- 회전만 하고 이 파일을 안 밀면:
--   · 어드민이 새 비밀번호를 보내면 이 다섯이 거부한다 → 예약 추가·삭제, 입실·퇴실 표시,
--     청소 표시가 통째로 안 된다.
--   · 옛 PIN 은 이 다섯을 **계속 연다** → 회전의 의미가 절반 사라진다.
-- 그래서 이 파일은 20260813111000(전환)과 **같은 순간에** 올라가야 한다.
--
-- 본문은 라이브 정의를 그대로 옮겼다 — 사람이 옮겨 적지 않고 덤프에서 기계로 변환했다.
-- 바뀐 것은 검사 한 줄뿐이다(`if p_password <> '<리터럴>' ... end if;` → `perform admin_check`).
-- 평문 리터럴은 이 파일에 들어오지 않는다.
--
-- ⚠️ **이 부류가 또 생기지 않게 하려면**: DB 편집기에서 함수를 직접 만들지 말 것.
--    admin_list_reservations 가 정확히 그렇게 리뷰도 버전관리도 없이 살아 있었다.

-- ── admin_add_reservation ──
create or replace function public."admin_add_reservation"(p_password text, p_source text, p_booking_no text, p_applied date, p_date date, p_start time without time zone, p_end time without time zone, p_guests integer, p_purpose text, p_option text, p_request text, p_name text, p_phone text, p_email text, p_amount integer, p_payment text, p_memo text) returns public."reservations"
    language plpgsql security definer
    set search_path to 'public'
    as $function$
declare
  r reservations;
begin
  perform public.admin_check(p_password);
  insert into reservations(
    source, booking_no, applied, date, start_time, end_time,
    guests, purpose, option_text, request, name, phone, email,
    amount, payment, memo
  ) values (
    p_source, p_booking_no, p_applied, p_date, p_start, p_end,
    p_guests, p_purpose, p_option, p_request, p_name, p_phone, p_email,
    p_amount, p_payment, p_memo
  )
  returning * into r;
  return r;
end;
$function$;

-- ── admin_delete_reservation ──
create or replace function public."admin_delete_reservation"(p_password text, p_id uuid) returns "void"
    language plpgsql security definer
    set search_path to 'public'
    as $function$
begin
  perform public.admin_check(p_password);
  delete from reservations where id = p_id;
end;
$function$;

-- ── admin_set_checkin ──
create or replace function public."admin_set_checkin"(p_password text, p_id uuid, p_value boolean) returns public."reservations"
    language plpgsql security definer
    set search_path to 'public'
    as $function$
declare
  r reservations;
begin
  perform public.admin_check(p_password);
  update reservations set checkin_done = p_value where id = p_id returning * into r;
  return r;
end;
$function$;

-- ── admin_set_checkout ──
create or replace function public."admin_set_checkout"(p_password text, p_id uuid, p_value boolean) returns public."reservations"
    language plpgsql security definer
    set search_path to 'public'
    as $function$
declare
  r reservations;
begin
  perform public.admin_check(p_password);
  update reservations set checkout_done = p_value where id = p_id returning * into r;
  return r;
end;
$function$;

-- ── admin_set_cleaning ──
create or replace function public."admin_set_cleaning"(p_password text, p_id uuid, p_value boolean) returns public."reservations"
    language plpgsql security definer
    set search_path to 'public'
    as $function$
declare
  r reservations;
begin
  perform public.admin_check(p_password);
  update reservations set cleaning_done = p_value where id = p_id returning * into r;
  return r;
end;
$function$;
