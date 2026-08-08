-- 예약 시간 변경(주로 연장) — 시각 하나만 고치는 게 아니라 **그 시각에 매달린 것들을 같이 푼다.**
--
-- 현장에서 연장은 흔한 일인데, 지금까지는 예약을 지우고 다시 만드는 수밖에 없었다. 그러면
-- 연락처·보증금·문자 이력이 통째로 날아간다(reservation_sms가 cascade로 지워진다).
--
-- 시간을 바꾸면 따라 움직여야 하는 것이 셋이다. 하나라도 빠뜨리면 **손님이 아직 안에 있는데
-- 기기가 꺼지거나, 이미 지난 시각 기준으로 문자가 안 나간다.**
--
--  1) **퇴실 자동화 표시(`checkout_automation_at`)를 지운다.** 이 컬럼이 차 있으면
--     `runTransition`이 '이미 했다'고 보고 새 퇴실 시각에 아무것도 하지 않는다. 21시에 끄고
--     22시로 연장하면 기기가 꺼진 채로 남는다.
--
--  2) **퇴실 문자 두 종을 `superseded`로 물러나게 한다.** 유니크 인덱스가 자리를 잡고 있어
--     그냥 두면 새 시각에 다시 안 나간다. 지우지 않고 물러나게 하는 이유는 장부가
--     '옛 시각에 이런 안내를 보냈다'는 사실을 계속 들고 있어야 하기 때문이다.
--
--  3) **입실 쪽은 건드리지 않는다.** 입실 준비를 다시 무장하면 이용 중인 손님 머리 위로
--     냉난방이 26도·조명이 프리셋으로 재설정된다 — 2026-08-08에 실제로 겪은 사고다
--     (control-setup.md J절). 시작 시각을 앞당기는 건 연장과 다른 일이라, 필요하면
--     사람이 어드민에서 따로 판단한다.
--
-- 시작 시각도 받는 이유는 '30분 늦게 시작해서 30분 늦게 끝나는' 조정이 실제로 있어서다.
-- 값을 그대로 넘기면 아무 일도 안 일어난다.

create or replace function public.admin_set_time(
  p_password text,
  p_id uuid,
  p_start time,
  p_end time
)
returns reservations
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r reservations;
  old_end time;
begin
  perform public.admin_list_reservations(p_password);

  select end_time into old_end from reservations where id = p_id;
  if old_end is null then
    raise exception 'id % 에 해당하는 예약이 없습니다', p_id;
  end if;

  if p_end <= p_start then
    raise exception '퇴실 시각이 입실 시각보다 늦어야 합니다 (% → %)', p_start, p_end;
  end if;

  update reservations
     set start_time = p_start,
         end_time = p_end,
         -- 퇴실 시각이 움직였을 때만 푼다. 시작만 바꾼 경우까지 풀면 이미 끝난 퇴실 종료가
         -- 다시 무장돼 엉뚱한 때 기기가 꺼진다.
         checkout_automation_at = case when p_end <> old_end then null else checkout_automation_at end
   where id = p_id
  returning * into r;

  if p_end <> old_end then
    update reservation_sms
       set status = 'superseded'
     where reservation_id = p_id
       and kind in ('checkout_soon', 'checkout')
       and status not in ('failed', 'superseded');
  end if;

  return r;
end;
$function$;
