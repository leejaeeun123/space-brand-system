-- 스클 파트너 API에서 받은 연락처·이메일로 기존 예약의 "빈 칸만" 채운다 (백필용).
--
-- Gmail 알림 메일에는 연락처·이메일이 실려오지 않아 spacecloud-gmail-sync.gs로 등록된 예약은
-- 이 두 필드가 비어 있다. 파트너 API에는 있으므로 사후에 메워 넣는다.
-- 상세: 06-applications/automation/README.md "주 경로 — 파트너 API"
--
-- 설계 두 가지:
--  1) 덮어쓰지 않는다. 이미 값이 있으면 그대로 둔다 — 수동으로 고친 값을 API 값이 밀어내면 안 된다.
--     그래서 몇 번을 돌려도 결과가 같다.
--  2) 비밀번호 검증은 admin_list_reservations에 위임한다. 평문 비밀번호를 이 파일에 또 박으면
--     같은 비밀이 repo 안에서 늘어나기만 한다. 틀린 비밀번호면 그쪽이 'invalid password'로 중단시킨다.

create or replace function public.admin_fill_contact(
  p_password text,
  p_booking_no text,
  p_phone text default null,
  p_email text default null
)
returns reservations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r reservations;
begin
  perform public.admin_list_reservations(p_password);

  update reservations set
    phone = coalesce(nullif(phone, ''), nullif(p_phone, '')),
    email = coalesce(nullif(email, ''), nullif(p_email, ''))
  where booking_no = p_booking_no
  returning * into r;

  if r.id is null then
    raise exception 'booking_no % 에 해당하는 예약이 없습니다', p_booking_no;
  end if;

  return r;
end;
$function$;
