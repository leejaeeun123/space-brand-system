-- 문자 안내 자동화 — 예약별 옵트인과 발송 장부.
--
-- 지금까지 입실·퇴실 안내는 어드민이 문구를 복사해 손으로 보냈다. 사람이 보내는 한
-- '늦게 갔다'와 '아예 안 갔다'를 아무도 모른다. 그래서 예약마다 자동발송을 켤 수 있게 하고,
-- 나간 것과 못 나간 것을 전부 장부에 남긴다.
--
-- 설계 넷, 되돌리기 전에 읽을 것:
--
--  1) **발송 이력을 reservations 컬럼으로 펴지 않는다.** 문자가 5종이라 `sms_checkin_at`류로
--     펴면 종류가 늘 때마다 마이그레이션이 붙고, 무엇보다 **실패 사유를 적을 자리가 없다.**
--     조용히 안 나간 문자는 없는 기능보다 나쁘다 — 아무도 모르기 때문이다.
--
--  2) **중복 발송은 부분 유니크 인덱스가 막는다.** `automate`는 anon key로 누구나 부를 수 있어
--     두 틱이 겹칠 수 있는데(20260807000000 참조), '보내기 전에 이미 보냈나 확인'은 두 호출이
--     나란히 통과한다. 그래서 발송 **전에** 'sending' 행을 먼저 넣어 자리를 잡는다(선점).
--     인덱스가 `status not in ('failed', 'superseded')`인 이유가 이것이다 — 둘만 자리를 비워
--     재시도를 허용한다. `expired`(창을 놓침)가 자리를 막는 것은 **의도한 것**이다 —
--     놓친 문자를 매 틱 영원히 다시 시도하지 않기 위해서다.
--
--     사람이 뒤늦게 다시 보내려면 기존 행을 `superseded`로 내리고 새 행을 만든다.
--     **이미 보낸 행을 `failed`로 고쳐 재사용하지 않는다** — 그러면 장부가 '보냈는데
--     실패로 적힌' 거짓말을 하게 되고, 손님은 받았는데 장부만 다르면 나중에 아무도 못 받는다.
--
--  3) **`admin_list_reservations`는 손대지 않는다.** 라이브 정의가 `returns setof reservations`라
--     새 컬럼이 자동으로 실려 나간다. 문자 이력만 `admin_list_sms`로 따로 내린다 — 지금 돌아가는
--     목록 RPC의 반환 형태를 바꾸면 어드민 전체가 같이 위험해진다.
--
--  4) **자동발송을 켜는 RPC는 여기 없다.** 켜는 즉시 첫 통(보증금/예약확정)이 나가야 하는데
--     SQL 함수는 문자를 못 보낸다. 그 일은 Edge Function의 `sms_auto` action이 한다
--     (플래그 변경과 발송이 같은 클릭 안에서 끝난다). 여기에 `admin_set_sms_auto`를 만들면
--     플래그만 켜지고 문자는 안 나가는 경로가 하나 더 생긴다.

-- ── 예약 쪽 ────────────────────────────────────────────────────────────────

alter table public.reservations
  add column if not exists sms_auto boolean not null default false;
comment on column public.reservations.sms_auto is
  '문자 자동발송 켬/끔. 기본 false = 옵트인이다. 기본을 true로 두면 이미 등록된 과거·미래 예약 전부에 문자가 나간다.';

alter table public.reservations
  add column if not exists deposit_required boolean not null default false;
comment on column public.reservations.deposit_required is
  '청소 보증금을 받는 예약인가. 문구가 갈린다 — true면 보증금 안내·환불 안내가 붙고, false면 예약 확정 안내 한 통으로 시작한다.';

-- ── 발송 장부 ──────────────────────────────────────────────────────────────

create table if not exists public.reservation_sms (
  id bigint generated always as identity primary key,
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  kind text not null check (kind in ('deposit', 'confirm', 'checkin', 'checkout_soon', 'checkout')),
  status text not null check (status in ('sending', 'sent', 'failed', 'no_phone', 'manual', 'expired', 'superseded')),
  to_phone text,
  body text,
  group_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

comment on table public.reservation_sms is
  '예약별 문자 발송 장부. 성공만이 아니라 실패·수동발송·창 놓침까지 남긴다.';
comment on column public.reservation_sms.status is
  'sending=선점만 하고 발송 중 · sent=발송됨 · failed=벤더가 거절(재시도 가능) · no_phone=자동발송은 켜져 있는데 연락처가 없어 못 보냄 · manual=번호가 없어 사람이 직접 보냄 · expired=창을 놓쳐 안 보냄 · superseded=뒤에 재발송으로 대체됨. sending인 채 오래 남아 있으면 함수가 발송 도중에 죽은 것이다 — 어드민에서 재발송으로 푼다.

no_phone이 failed와 따로 있는 이유: failed는 유니크 인덱스 밖이라 다음 틱이 곧바로 다시 시도하는데, 연락처가 없는 상태는 사람이 번호를 넣기 전까지 절대 안 풀린다. failed로 적으면 유예 창(최대 30분) 동안 매 분 같은 실패를 다시 쌓고 채널을 도배한다.';
comment on column public.reservation_sms.body is
  '실제로 보낸 본문. 템플릿은 시간이 지나면 바뀌므로, "그때 무엇을 보냈나"는 여기에만 남는다.';
comment on column public.reservation_sms.group_id is
  'SOLAPI groupId. 벤더 콘솔에서 같은 건을 찾을 때 쓴다.';

create unique index if not exists reservation_sms_once
  on public.reservation_sms (reservation_id, kind)
  where status not in ('failed', 'superseded');

create index if not exists reservation_sms_by_reservation
  on public.reservation_sms (reservation_id);

-- 손님 페이지도 같은 anon key를 쓴다. 정책을 하나도 두지 않아 anon·authenticated는 전부 막히고,
-- 아래 SECURITY DEFINER 함수와 Edge Function의 service_role만 닿는다.
alter table public.reservation_sms enable row level security;

-- ── RPC ────────────────────────────────────────────────────────────────────
--
-- 비밀번호 검증은 전부 admin_list_reservations에 위임한다. 평문 비밀번호를 SQL에 또 박으면
-- 같은 비밀이 repo와 DB 안에서 늘어나기만 한다(admin_fill_contact와 같은 방식).

-- 연락처를 **덮어쓴다.** admin_fill_contact와 일부러 다르다 — 그쪽은 빈 칸만 채우고
-- booking_no로만 매칭해서, 오타 수정도 못 하고 수동 등록 예약(booking_no가 null)은 아예
-- 손대지 못한다. 문자를 보내려면 사람이 그 자리에서 번호를 고쳐 넣을 수 있어야 한다.
create or replace function public.admin_set_phone(
  p_password text,
  p_id uuid,
  p_phone text
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

  update reservations
     set phone = nullif(btrim(p_phone), '')
   where id = p_id
  returning * into r;

  if r.id is null then
    raise exception 'id % 에 해당하는 예약이 없습니다', p_id;
  end if;

  return r;
end;
$function$;

create or replace function public.admin_set_deposit(
  p_password text,
  p_id uuid,
  p_value boolean
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

  update reservations
     set deposit_required = p_value
   where id = p_id
  returning * into r;

  if r.id is null then
    raise exception 'id % 에 해당하는 예약이 없습니다', p_id;
  end if;

  return r;
end;
$function$;

-- 어드민 화면이 kind별 상태를 그리려면 장부 전체가 필요하다. 범위를 좁히지 않는 것은
-- admin_list_reservations가 이미 전 기간을 내리는 것과 같은 선택이다 — 둘 중 하나만
-- 잘라두면 화면에 '예약은 있는데 문자 이력은 없는' 구간이 생겨 더 헷갈린다.
create or replace function public.admin_list_sms(p_password text)
returns setof reservation_sms
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_list_reservations(p_password);
  return query select * from reservation_sms order by created_at;
end;
$function$;
