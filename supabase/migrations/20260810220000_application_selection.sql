-- 공간 지원 신청자 선정·보류 — 결과 상태와 결과 안내 문자 장부.
--
-- 설계 다섯, 되돌리기 전에 읽을 것:
--
--  1) **상태는 셋이다.** received(접수) · selected(선정) · held(보류).
--     '탈락'은 두지 않았다(형운 결정, 2026-08-10) — 보류 문구가 "자리가 생기면 연락드린다"라
--     사실상 대기열이고, 명시적 탈락을 만들면 그에 맞는 문구가 하나 더 필요해진다.
--     나중에 필요하면 CHECK에 'rejected'를 더하고 문구를 추가한다.
--
--  2) **선정·보류 시각을 따로 남긴다(`decided_at`).** 보류였다가 나중에 선정되는 경로가 있어
--     상태만으로는 "언제 바뀌었나"를 알 수 없다. 대기가 길어진 사람을 찾으려면 이 값이 필요하다.
--
--  3) **문자 장부를 reservation_sms와 나눈다.** 저기는 `reservation_id`에 FK가 걸려 있어
--     신청서를 가리킬 수 없다. 컬럼을 nullable로 풀어 한 테이블에 섞으면 '예약도 신청도 아닌 행'이
--     생길 수 있고, 그때부터 어느 쪽 화면도 그 행을 책임지지 않는다.
--
--  4) **중복 발송은 부분 유니크 인덱스가 막는다**(reservation_sms와 같은 방식). 선정 문자를 두 번
--     보내면 받는 사람은 자기가 두 번 선정된 줄 안다. 다만 `failed`·`superseded`는 자리를 비워
--     재시도를 허용한다.
--     ⚠️ 여기서 `kind`를 유니크 키에 넣는 것이 중요하다 — 보류 문자를 받은 사람이 나중에 선정되면
--     **선정 문자는 나가야 한다**. (reservation_id, kind) 대신 (application_id, kind)다.
--
--  5) **12시간 상한은 이 마이그레이션이 강제하지 않는다.** 예약은 스페이스클라우드에서 이뤄져
--     우리 DB를 지나지 않으므로, 여기서 막을 방법이 없다. 상한은 문구로 알리고 지원금 신청
--     단계에서 사람이 대조한다(형운 결정). 강제하려면 예약과 신청자를 잇는 키가 필요한데,
--     지금은 이름·연락처 대조가 전부다.

-- ── 상태 ───────────────────────────────────────────────────────────────────

alter table public.support_applications
  add column if not exists status text not null default 'received'
    check (status in ('received', 'selected', 'held'));
comment on column public.support_applications.status is
  'received=접수(결과 미정) · selected=선정 · held=보류(대기). 탈락 상태는 일부러 없다 — 보류가 대기열 역할을 한다.';

alter table public.support_applications
  add column if not exists decided_at timestamptz;
comment on column public.support_applications.decided_at is
  '선정·보류를 마지막으로 정한 시각. 상태만으로는 "언제 바뀌었나"를 알 수 없어 따로 둔다 — 보류가 길어진 사람을 찾을 때 쓴다.';

alter table public.support_applications
  add column if not exists admin_memo text;
comment on column public.support_applications.admin_memo is
  '선정·보류 사유 메모. 사람이 나중에 "왜 이렇게 정했더라"를 되짚는 유일한 자리다.';

-- ── 결과 안내 문자 장부 ────────────────────────────────────────────────────

create table if not exists public.application_sms (
  id bigint generated always as identity primary key,
  application_id bigint not null references public.support_applications(id) on delete cascade,
  kind text not null check (kind in ('selected', 'held')),
  status text not null check (status in ('sending', 'sent', 'failed', 'no_phone', 'manual', 'superseded')),
  to_phone text,
  body text,
  group_id text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

comment on table public.application_sms is
  '선정·보류 결과 안내 문자 장부. 성공만이 아니라 실패·수동발송까지 남긴다 — 조용히 안 간 문자는 없는 기능보다 나쁘다.';
comment on column public.application_sms.status is
  'sending=선점만 하고 발송 중 · sent=발송됨 · failed=벤더가 거절(재시도 가능) · no_phone=문자를 받을 수 없는 번호라 사람이 직접 보내야 함 · manual=사람이 직접 보냄 · superseded=재발송으로 대체됨.';
comment on column public.application_sms.body is
  '실제로 보낸 본문. 템플릿은 바뀌므로 "그때 무엇을 보냈나"는 여기에만 남는다.';

-- (application_id, kind) 기준. **kind가 키에 있어야** 보류 문자를 받은 사람이 나중에
-- 선정됐을 때 선정 문자가 나갈 수 있다.
create unique index if not exists application_sms_once
  on public.application_sms (application_id, kind)
  where status not in ('failed', 'superseded');

create index if not exists application_sms_by_application
  on public.application_sms (application_id);

-- 신청 페이지와 같은 anon key를 쓴다. 정책을 하나도 두지 않아 Edge Function(service_role)만 닿는다.
alter table public.application_sms enable row level security;

-- ── 어드민 조회 ────────────────────────────────────────────────────────────
--
-- ⚠️ `admin_list_applications`는 `returns setof support_applications`라 **새 컬럼이 자동으로
-- 실려 나간다** — 고칠 필요가 없다(20260810100000에서 그 형태를 고른 이유가 이것이다).
-- 문자 이력만 따로 내린다.
create or replace function public.admin_list_application_sms(p_password text)
returns setof application_sms
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.admin_list_reservations(p_password);
  return query select * from application_sms order by created_at;
end;
$function$;
