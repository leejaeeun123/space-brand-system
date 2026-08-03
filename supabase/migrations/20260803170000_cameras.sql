-- CCTV 카메라 인벤토리 + 마지막 보고 상태.
--
-- **영상은 이 DB를 지나가지 않는다.** 여기 있는 건 '어떤 카메라가 있다고 선언했는가'와
-- '그게 지금 살아 있는가'뿐이다. 실제 프레임은 합정 맥의 MediaMTX가 직접 브라우저에
-- 물린다(터널 경유). 제어(devices)와 영상을 같은 경로에 태우지 않는 이유는 규모다 —
-- 제어는 초당 JSON 한 건이지만 영상은 초당 수 Mbps라 Edge Function·DB로는 못 나른다.
--
-- devices 테이블에 카메라를 끼워넣지 않은 이유: 카메라는 명령을 받지 않고 power도 없다.
-- kind='camera'로 우겨넣으면 capabilities=[]·power=null인 행이 생겨서, '모름'을 경고로
-- 표시하는 기존 UI가 카메라마다 영구히 경고를 띄운다.

create table if not exists public.cameras (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,                       -- 사람이 부르는 이름 ('현관')
  -- MediaMTX의 path 이름. mediamtx.yml에 선언한 값과 **글자까지 같아야** 한다.
  -- 스트림 URL(/<path>/index.m3u8)과 녹화 경로에 그대로 박히므로 URL 안전 문자만 받는다.
  -- Tasmota의 Topic 등록과 같은 계약이다 — 실체는 저쪽에 있고 여기는 선언일 뿐이라,
  -- 오타가 나면 '카드는 뜨는데 영상만 안 나오는' 상태가 된다.
  path       text not null unique
               check (path ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  sort       integer not null default 0,          -- 화면에 뜨는 순서
  created_at timestamptz not null default now()
);

-- 합정 에이전트가 MediaMTX API를 읽어 주기적으로 밀어넣는다.
create table if not exists public.camera_state (
  camera_id    uuid primary key references public.cameras(id) on delete cascade,
  -- 카메라 → MediaMTX 연결이 살아 있나 (MediaMTX가 소스를 물고 있는 상태).
  online       boolean not null default false,
  -- ⚠️ **녹화는 따로 확인해야 한다.** 스트림이 살아 있어도 디스크가 차거나 권한이 막히면
  -- 녹화만 조용히 멈춘다. 그 상태로 몇 주가 지나면 정작 분쟁이 났을 때 아무것도 없다.
  -- 그래서 이 값은 '설정이 켜져 있나'가 아니라 **최근 세그먼트가 실제로 디스크에 떨어졌나**로
  -- 판정한다(에이전트 cameras.js 참조). 설정 플래그는 거짓말을 하지만 파일은 하지 않는다.
  recording    boolean not null default false,
  -- 녹화 파티션 남은 용량(GB). 보관기간을 못 채우고 밀려나기 시작하는 걸 미리 본다.
  disk_free_gb numeric,
  -- ⚠️ 스트림에 오디오 트랙이 섞였나. true면 **위법 녹음이 진행 중**이라는 뜻이다.
  -- 「개인정보 보호법」 제25조 제5항은 고정형 영상정보처리기기의 녹음기능 사용을 금지한다.
  -- 카메라는 마이크가 내장돼 있고 RTSP에 오디오를 기본으로 실어 보내는데, MediaMTX에는
  -- 트랙을 버리는 설정이 없다 — 즉 **카메라에서 끄는 것 말고는 막을 방법이 없고**, 그게
  -- 펌웨어 업데이트로 조용히 되살아나면 아무도 모른다. 그래서 상태로 승격해 화면에 띄운다.
  has_audio    boolean not null default false,
  -- device_state와 달리 reported_at이 없다. 저쪽은 '기기가 보고한 시각'과 '우리가 쓴 시각'이
  -- 실제로 다르지만(ThinQ는 전자가 아예 없다), 여기서는 에이전트가 곧 관측자라 늘 같은 값이다.
  -- 항상 같은 두 컬럼을 두면 나중에 누가 둘이 다른 줄 알고 잘못된 쪽을 읽는다.
  --
  -- null = 이 카메라에 대해 한 번도 보고를 받은 적 없음(등록만 됨).
  -- device_state와 같은 규칙이다 — now()를 기본값으로 주면 '방금 갱신됨'이라는 거짓말이 되고
  -- 화면이 '0초 전'이라 표시해 멀쩡한 것처럼 보인다.
  updated_at   timestamptz
);

-- devices와 같은 이유로 RLS를 켜되 정책을 만들지 않는다 = anon 키로는 읽기도 쓰기도 불가.
-- 접근은 Edge Function(service_role)과 합정 에이전트뿐이다. 카메라 목록이 새면 스트림
-- 경로(path)가 새는 것이고, 그건 곧 URL 추측의 출발점이 된다.
alter table public.cameras enable row level security;
alter table public.camera_state enable row level security;
