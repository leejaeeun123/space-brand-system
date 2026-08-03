-- 공간 제어(조명·냉난방) 기기 인벤토리 + 마지막 상태 캐시.
--
-- Space(nmwc-ai/Space, 유재형)의 src/control 스키마를 이 프로젝트로 이식한 것이다.
-- 원본과 다른 점 두 가지 — 둘 다 여기가 단일 공간(TYPE LOUNGE 합정)이기 때문이다:
--   1) account_id / space_id 컬럼 없음. 원본은 멀티테넌시라 공간별 격리가 설계의 축이지만
--      여기엔 공간이 하나뿐이라 그 컬럼들은 항상 같은 값이 된다.
--   2) 기능 플래그(account_features) 없음. 원본은 "NMWC 계정에만 노출"을 코드로 강제했는데
--      여기선 노출 대상이 운영자 한 명뿐이다.
--
-- ⚠️ 이 두 테이블은 RLS를 켜되 정책을 만들지 않는다 = anon 키로는 읽기도 쓰기도 불가능하다.
-- 접근은 오직 Edge Function(service_role)을 통해서만 한다. 이유는 reservations와 다르다:
-- 예약은 읽혀도 손님 정보가 새는 정도지만, 기기 제어는 소스만 본 사람이 손님 이용 중에
-- 조명·냉난방을 끌 수 있다. 게다가 ThinQ PAT는 절대 브라우저에 내려가면 안 되므로
-- 어차피 서버 경유가 강제된다.

create table if not exists public.devices (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,                       -- 사람이 부르는 이름 ('메인 조명')
  kind          text not null check (kind in ('light', 'hvac')),
  adapter       text not null check (adapter in ('tasmota', 'thinq')),
  -- 기기 실체. tasmota=MQTT 토픽 세그먼트 / thinq=벤더 deviceId.
  -- 등록 후 불변이다 — 주소가 바뀌면 그건 '다른 기기'이고, device_state가 device_id에
  -- 매달려 있어 주소만 갈아끼우면 이전 기기의 상태가 새 기기 것인 척 남는다.
  address       text not null,
  -- 쓰기 가능한 축만: ['power','temp','mode','wind']. ThinQ는 프로파일에서 파생한다.
  capabilities  jsonb not null default '[]'::jsonb,
  -- 값의 경계(프로파일 파생). {"temp":{"min":18,"max":30,"step":1,"unit":"C"},"modes":[...],"wind":[...]}
  -- Tasmota는 null(스위치는 제약 없음). 하드코딩 금지 — 문서 예시와 실기기가 달랐다는 게
  -- 원본 스펙의 실측 결론이다(ss-4er).
  constraints   jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (adapter, address)
);

-- 마지막 알려진 상태 캐시. 조회는 전부 여기서 읽는다 — 기기를 실시간으로 찌르지 않는다.
-- (오프라인 기기 하나가 요청을 타임아웃까지 잡는 걸 막기 위한 원본 설계 D4)
create table if not exists public.device_state (
  device_id   uuid primary key references public.devices(id) on delete cascade,
  online      boolean not null default false,
  -- ⚠️ null = '모름'이며 'OFF'가 아니다. 둘을 합치면 꺼진 줄 알았는데 실제로는 켜져 있는
  -- 상황(= 냉난방 무한 가동)이 조용히 숨는다. UI가 반드시 구분해 표시해야 한다.
  power       text check (power in ('ON', 'OFF')),
  attrs       jsonb not null default '{}'::jsonb,   -- {"mode":"COOL","target_temp":24,...}
  reported_at timestamptz,                           -- 기기/벤더가 보고한 시각 (ThinQ는 없음)
  -- null = 이 기기로부터 한 번도 상태를 받은 적 없음(등록만 됨).
  -- now()를 기본값으로 주면 "방금 갱신됨"이라는 거짓말이 되어 UI가 '0초 전'이라 표시한다.
  updated_at  timestamptz
);

alter table public.devices enable row level security;
alter table public.device_state enable row level security;
