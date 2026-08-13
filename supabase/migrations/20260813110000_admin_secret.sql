-- 어드민 비밀번호를 해시로 검증하는 단일 뿌리(`admin_check`).
--
-- **왜 필요한가.** 지금 이 시스템의 인가 판정은 SQL 함수 본문 안의 평문 비교다
-- (`admin_set_cancelled`는 마이그레이션에 값이 그대로 박혀 있고, 나머지 아홉 함수는
-- `admin_list_reservations`에 위임하는데 그 정의는 라이브 DB에만 있다). 평문은 `pg_proc.prosrc`에
-- 남아 DB 덤프·백업·대시보드 열람자 전원에게 보이고, 그 값 하나가 예약자 이름·연락처·
-- 주민번호 복호화·CCTV 자격증명을 전부 연다.
--
-- **이 파일은 아무 동작도 바꾸지 않는다.** 도구(테이블 + 함수)만 만든다. 실제 전환은
-- 다음 파일(`20260813111000_admin_use_secret.sql`)이 하고, 그 사이에 사람이 비밀번호를 심는다.
-- 셋을 한 파일에 넣으면 `db push`와 비밀번호 주입 사이에 **어드민이 통째로 잠기는 구간**이
-- 생긴다 — 무인 공간에서 그 구간은 현장 대응 불가를 뜻한다.
--
-- ────────────────────────────────────────────────────────────────────────
-- 적용 순서 (이 순서를 지켜야 잠기지 않는다)
--   1) 이 파일을 push 한다.                 → 아직 아무것도 안 바뀐다
--   2) 아래 '비밀번호 심기'를 실행한다.      → 해시가 들어간다
--   3) 20260813111000 을 push 한다.          → 그때부터 해시로 검증한다
--
-- 비밀번호 심기 (psql 또는 Supabase SQL 편집기에서 **한 번만**, 값은 여기 적지 않는다):
--
--   select public.admin_set_password('<새 비밀번호>');
--
-- 해싱을 함수에 감싼 이유: pgcrypto가 `extensions`에 있는지 `public`에 있는지는 프로젝트마다
-- 다른데, 손으로 `extensions.crypt(...)`를 적으면 그게 틀린 쪽에서 실패한다. 함수가 자기
-- search_path로 알아서 찾는다.
--
-- ⚠️ 이때 **비밀번호를 새 값으로 바꾼다.** 기존 값은 이미 이 레포의 git 이력에 평문으로
--    남아 있어(20260803000000) 회전하지 않으면 이 작업의 절반이 무의미하다.
--    Edge Function 시크릿 `ADMIN_PASSWORD`도 같은 값으로 함께 바꾼다 — 두 곳이 어긋나면
--    어드민 화면은 열리는데 기기 제어만 안 되는 식으로 조용히 갈라진다.
-- ────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admin_secret (
  id int primary key default 1 check (id = 1),
  pw_hash text not null,
  rotated_at timestamptz not null default now()
);

comment on table public.admin_secret is
  '어드민 비밀번호의 bcrypt 해시. 행은 하나뿐이다(id=1). 평문은 어디에도 저장하지 않는다.';
comment on column public.admin_secret.rotated_at is
  '마지막으로 비밀번호를 바꾼 시각. 회전 주기를 사람이 눈으로 볼 수 있게 남긴다.';

-- RLS on + 정책 없음 = service_role만. anon 키로는 해시조차 못 읽는다.
alter table public.admin_secret enable row level security;

/**
 * 비밀번호가 맞으면 조용히 통과, 틀리면 예외.
 *
 * 반환값이 없고 예외로만 말하는 이유는, 기존 아홉 함수가 쓰던
 * `perform public.admin_list_reservations(p_password)` 관용구를 그대로 대체하기 위해서다 —
 * 호출부는 `perform public.admin_check(p_password);` 한 줄로 바뀐다.
 *
 * 예외 문구를 'invalid password'로 맞춘 것도 의도다. 기존 함수들이 같은 문구로 실패했고,
 * `admin.html`은 그 문구가 아니라 실패 자체로 잠금 화면을 띄운다 — 문구를 바꾸면 어딘가에서
 * 조용히 다른 분기를 탈 수 있다.
 *
 * **비밀번호가 안 심겨 있으면 통과가 아니라 실패다.** 설정 안 된 상태가 '누구나 통과'로
 * 해석되면 안 된다(Edge Function의 `ADMIN_PASSWORD` 미설정 처리와 같은 태도).
 * 다만 그냥 'invalid password'로 뭉개면 원인을 못 찾으므로, 이 경우만 문구를 따로 준다.
 */
-- ⚠️ `search_path`에 스키마를 **두 개 이상** 줄 땐 따옴표로 묶지 않는다.
--    `set search_path to 'public, extensions'`는 스키마 둘이 아니라 `"public, extensions"`라는
--    이름의 **단일 스키마**로 해석돼, `crypt`를 못 찾고 모든 인증이 실패한다(실측으로 확인).
--    이 레포의 다른 함수들이 `'public'`처럼 따옴표를 쓰는 것은 스키마가 하나뿐이라 우연히 맞는 것이다.
create or replace function public.admin_check(p_password text)
returns void
language plpgsql
security definer
set search_path to public, extensions
as $function$
declare
  stored text;
begin
  select pw_hash into stored from public.admin_secret where id = 1;

  if stored is null then
    raise exception 'admin_secret 미설정 — 비밀번호를 심어야 합니다(20260813110000 주석 참조)';
  end if;

  -- crypt(입력, 저장된해시) = 저장된해시  ⇔  입력이 맞다. bcrypt라 비교 자체가 상수 시간이다.
  if crypt(p_password, stored) <> stored then
    raise exception 'invalid password';
  end if;
end;
$function$;

comment on function public.admin_check(text) is
  '어드민 비밀번호 검증의 단일 뿌리. 맞으면 통과, 틀리거나 미설정이면 예외를 던진다.';

/**
 * 비밀번호를 심는다(회전 포함). **평문은 인자로만 지나가고 어디에도 저장되지 않는다.**
 *
 * 이 함수가 따로 있는 이유는 두 가지다:
 *  · pgcrypto가 `extensions`에 있는지 `public`에 있는지가 프로젝트마다 달라, 사람이 손으로
 *    스키마를 적으면 틀린 쪽에서 실패한다. 여기 search_path가 대신 찾는다.
 *  · 해싱 파라미터(bcrypt cost 12)를 한 곳에 고정한다 — 심는 사람마다 다른 값을 쓰면
 *    비밀번호마다 강도가 달라진다.
 *
 * ⚠️ 이 호출은 SQL 편집기 기록·psql 히스토리에 평문으로 남는다. 심은 뒤 히스토리를 지우거나,
 *    애초에 기록이 남지 않는 경로로 실행한다.
 */
create or replace function public.admin_set_password(p_password text)
returns void
language plpgsql
security definer
set search_path to public, extensions
as $function$
begin
  if p_password is null or length(p_password) < 16 then
    -- 시도 제한이 있어도 짧은 비밀번호는 얇은 방어다. 옛 값이 10자리 숫자 PIN이었다.
    raise exception '비밀번호는 16자 이상이어야 합니다';
  end if;

  insert into public.admin_secret (id, pw_hash)
  values (1, crypt(p_password, gen_salt('bf', 12)))
  on conflict (id) do update set pw_hash = excluded.pw_hash, rotated_at = now();
end;
$function$;

comment on function public.admin_set_password(text) is
  '어드민 비밀번호를 심는다(회전 포함). 평문은 저장되지 않는다. 절차는 06-applications/control-setup.md M절.';
