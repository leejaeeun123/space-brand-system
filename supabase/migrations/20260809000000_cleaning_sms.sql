-- 청소 안내 문자 — 날짜 단위 발송 장부.
--
-- 담당자에게 매일 아침 당일 스케줄과 청소 가능 구간을 보내고, 그 뒤 스케줄이 바뀌면
-- 변경 안내를 보낸다. 손님 문자(`reservation_sms`)와 **테이블을 나눈 이유가 설계의 출발점이다.**
--
-- 설계 넷, 되돌리기 전에 읽을 것:
--
--  1) **`reservation_sms`에 얹을 수 없다.** 그쪽은 `reservation_id`가 NOT NULL FK인데
--     다이제스트에는 부모 예약이 없다 — 예약이 0건인 날에도 보내기로 했기 때문이다
--     (침묵은 '예약 없음'과 'cron이 죽음'을 구분해주지 않는다). `kind` CHECK도 5종으로
--     닫혀 있다. 상태 어휘와 부분 유니크 선점 방식만 그대로 빌렸다.
--
--  2) **중복 발송은 부분 유니크 인덱스가 막는다.** `automate`는 anon key로 누구나 부를 수 있어
--     두 틱이 겹칠 수 있는데(20260807000000 참조), '보내기 전에 이미 보냈나 확인'은 두 호출이
--     나란히 통과한다. 그래서 발송 **전에** 'sending' 행을 먼저 넣어 자리를 잡는다.
--     변경 안내는 하루에 여러 번 나가므로 날짜만으로는 못 가른다 — 스냅샷 지문으로 가른다.
--
--  3) **`failed`가 인덱스 안에 있다. `reservation_sms`와 다른 유일한 지점이다.**
--     그쪽은 손님 안내가 반드시 나가야 해서 실패를 재시도 가능하게 열어뒀지만, 여기서는
--     같은 본문이 Mattermost에 동시에 올라가 **정보가 유실되지 않는다.** 재시도를 열면
--     잔액 소진·발신번호 문제처럼 다음 틱에도 똑같이 실패하는 사유에서 1분마다 실패 행과
--     알림이 쌓여 채널을 못 쓰게 된다. 도배가 유실보다 나쁘다.
--     사람이 다시 보내려면 기존 행을 'superseded'로 내린다(맨 아래 참조).
--
--  4) **`snapshot`을 행에 같이 저장한다.** 이게 다음 틱이 변경을 재는 기준선이다. 따로 두면
--     '무엇을 말했는가'와 '무엇을 기준으로 비교하는가'가 갈라진다. 특히 22시 이후 변경을
--     'expired'로 남길 때도 스냅샷을 채워야 기준선이 전진해 **같은 변경을 매 틱 다시 감지하는
--     무한 루프가 끊긴다.**

create table if not exists public.cleaning_sms (
  id bigint generated always as identity primary key,
  date date not null,
  kind text not null check (kind in ('digest', 'update')),
  status text not null check (status in ('sending', 'sent', 'failed', 'expired', 'superseded')),
  to_phone text,
  body text,
  group_id text,
  error text,
  snapshot jsonb,
  fingerprint text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

comment on table public.cleaning_sms is
  '청소 담당자에게 나가는 문자의 날짜 단위 장부. 성공만이 아니라 실패·억제까지 남긴다.';
comment on column public.cleaning_sms.date is
  '이 문자가 말하는 KST 달력 날짜. 발송 시각이 아니다 — 자정 넘겨 보낼 일은 없지만 둘은 다른 개념이다.';
comment on column public.cleaning_sms.status is
  'sending=선점만 하고 발송 중 · sent=발송됨 · failed=벤더가 거절(자동 재시도 안 함) · expired=보낼 시간대가 아니라 문자 없이 Mattermost로만 알림 · superseded=사람이 재발송하려고 물러나게 함. sending인 채 오래 남아 있으면 함수가 발송 도중에 죽은 것이다.';
comment on column public.cleaning_sms.body is
  '실제로 보낸 본문. 템플릿은 시간이 지나면 바뀌므로 "그때 무엇을 보냈나"는 여기에만 남는다.';
comment on column public.cleaning_sms.snapshot is
  '이 문자가 말한 스케줄(ScheduleSnapshot). 다음 틱이 변경을 재는 기준선이다. expired 행도 반드시 채운다 — 안 채우면 같은 변경을 매 틱 다시 감지한다.';
comment on column public.cleaning_sms.fingerprint is
  'snapshot의 SHA-256. 겹친 두 틱이 같은 변경을 계산했을 때 하나만 통과시키는 열쇠다. digest는 날짜로 이미 갈리므로 쓰지 않는다.';

-- 하루 한 통.
create unique index if not exists cleaning_sms_digest_once
  on public.cleaning_sms (date)
  where kind = 'digest' and status <> 'superseded';

-- 같은 변경은 한 번만. 하루 안에 여러 번 바뀔 수 있으므로 지문으로 가른다.
create unique index if not exists cleaning_sms_update_once
  on public.cleaning_sms (date, fingerprint)
  where kind = 'update' and status <> 'superseded';

create index if not exists cleaning_sms_by_date
  on public.cleaning_sms (date, created_at);

-- 손님 페이지도 같은 anon key를 쓴다. 정책을 하나도 두지 않아 anon·authenticated는 전부 막히고,
-- Edge Function의 service_role만 닿는다(`reservation_sms`와 같은 방식).
-- 이 테이블에는 예약자 실명이 스냅샷으로 들어 있어 특히 그렇다.
alter table public.cleaning_sms enable row level security;

-- 재발송(사람이 직접):
--   update cleaning_sms set status = 'superseded'
--    where date = '2026-08-09' and kind = 'digest' and status <> 'superseded';
-- 다음 틱이 새로 보낸다. **22:00 전에만 통한다** — 그 뒤에는 발송 판정이 expired라
-- 문자를 보내지 않는다. 그 시각에 오늘 청소 안내를 보내는 것이 이미 의미가 없어서다.
