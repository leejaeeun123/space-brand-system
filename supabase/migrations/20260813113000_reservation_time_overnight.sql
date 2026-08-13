-- 자정을 넘기는 예약의 시간 수정을 허용한다.
--
-- **왜 막혀 있었나.** 원본(20260808200000)은 `p_end <= p_start`를 거부했다. 하루 안에서만
-- 생각하면 맞는 규칙이다.
--
-- **왜 틀렸나.** 이 시스템은 자정 넘김 예약을 정식으로 지원한다 — `automation/windows.ts`의
-- `endTime()`이 종료가 시작보다 이르면 다음 날로 해석하고(18:00~00:00, 22:00~02:00),
-- 실제로 그런 예약이 들어온다(2026-08-11 19:00~00:00). 그런데 어드민에서 **고칠 수가**
-- 없었다. 결과가 둘이었다:
--   · 22:00~00:30으로 **연장**을 못 한다 → 이 모달이 없애려던 '삭제 후 재생성'으로 되돌아가고,
--     그러면 연락처·보증금·문자 이력이 통째로 날아간다.
--   · 이미 자정을 넘긴 예약(end=00:00)은 **시작 시각만** 고치려 해도 저장이 거부된다.
--
-- 같은 값(`p_end = p_start`)은 여전히 거부한다. 0시간인지 24시간인지 읽는 사람마다 다르게
-- 이해하는 입력이고, 실수로 눌렀을 가능성이 훨씬 크다.
--
-- 나머지 본문은 원본 그대로다 — 특히 `checkout_automation_at` 해제 조건은 손대지 않았다.

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

  -- 종료가 시작보다 이르면 '다음 날 종료'다(windows.ts의 endTime과 같은 해석).
  -- 같은 값만 막는다 — 그건 해석이 갈리는 입력이다.
  if p_end = p_start then
    raise exception '퇴실 시각이 입실 시각과 같습니다 (% → %)', p_start, p_end;
  end if;

  update reservations
     set start_time = p_start,
         end_time = p_end,
         -- 퇴실 시각이 움직였을 때만 푼다. 시작만 바꾼 경우까지 풀면 이미 끝난 퇴실 종료가
         -- 다시 무장돼 엉뚱한 때 기기가 꺼진다.
         checkout_automation_at = case when p_end <> old_end then null else checkout_automation_at end
   where id = p_id
  returning * into r;

  -- 퇴실 시각이 바뀌면 이미 예약돼 있던 퇴실 안내 문자를 무효로 내린다. 안 내리면 옛 시각으로
  -- 잡힌 문자가 그대로 나가 손님이 틀린 시각을 안내받는다. (원본 20260808200000 그대로)
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
