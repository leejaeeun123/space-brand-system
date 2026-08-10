-- 어드민이 공간 지원 신청 내역을 읽는 유일한 경로.
--
-- 테이블은 RLS를 켜되 정책이 하나도 없어(20260810000000) anon 키로는 닿지 않는다. 접수는
-- Edge Function이 service_role로 넣고, 읽기는 이 SECURITY DEFINER 함수가 연다.
--
-- **비밀번호 검증은 admin_list_reservations에 위임한다.** `admin_list_sms`·`admin_set_phone`과
-- 같은 방식이다 — 평문 비밀번호를 SQL에 또 박으면 같은 비밀이 repo와 DB 안에서 늘어나기만 하고,
-- 나중에 바꿀 때 한 군데를 빠뜨린다.
--
-- `returns setof support_applications`인 이유도 같다 — 나중에 컬럼이 붙어도 자동으로 실려
-- 나가서, 컬럼을 추가할 때 이 함수를 같이 고치는 걸 잊어 화면에만 안 보이는 일이 없다.
--
-- 최신순으로 내린다. 신청은 예약과 달리 '오늘 무엇이 있나'가 아니라 '새로 뭐가 들어왔나'로
-- 읽는 목록이라, 화면이 정렬을 다시 하지 않아도 맨 위가 방금 들어온 것이어야 한다.

create or replace function public.admin_list_applications(p_password text)
returns setof support_applications
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_list_reservations(p_password);
  return query select * from support_applications order by created_at desc;
end;
$function$;
