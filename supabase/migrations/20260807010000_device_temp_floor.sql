-- 냉난방 목표온도 하한(24도) 강제를 위한 감시 시계.
--
-- 행이 있다 = 그 기기가 하한 미만으로 **가동 중**인 것을 `below_since`부터 관찰하고 있다.
-- 행이 없다 = 지금은 정상이거나 꺼져 있다.
--
-- `device_state`에 컬럼을 더하지 않은 이유: 그 테이블은 **벤더가 보고한 상태**의 캐시이고,
-- 이 값은 **우리 정책의 집행 기록**이다. 한 테이블에 섞으면 '기기가 말한 것'과 '우리가 정한
-- 것'의 경계가 흐려지고, 상태 갱신(upsert)이 집행 기록을 밟고 지나갈 여지가 생긴다.
--
-- 유예 시간(5분)과 하한(24도)은 코드(`automation/enforce.ts`)에 있다 — 정책 숫자를 SQL과 TS
-- 양쪽에 두면 한쪽만 고쳐지는 순간 조용히 어긋난다.

create table if not exists public.device_temp_floor (
  device_id    uuid primary key references public.devices(id) on delete cascade,
  below_since  timestamptz not null
);

comment on table public.device_temp_floor is
  '냉난방이 온도 하한 미만으로 가동하기 시작한 시각. 유예가 지나면 자동화가 하한으로 되돌리고 행을 지운다. 행 없음 = 정상 또는 꺼짐.';

-- `devices`와 같은 이유로 RLS를 켜되 정책을 만들지 않는다 = anon 키로는 읽기도 쓰기도
-- 불가능하고, Edge Function(service_role)만이 유일한 접근 경로다.
alter table public.device_temp_floor enable row level security;
