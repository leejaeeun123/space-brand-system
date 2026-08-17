-- 어드민 비밀번호의 16자 최소 길이 제한을 없앤다 (형운 결정, 2026-08-17).
--
-- 20260813110000이 `length(p_password) < 16`으로 바닥을 깔았다. 근거는 그때도 맞았다 —
-- 옛 값이 10자리 숫자 PIN이었고, 시도 제한만으로는 좁은 키스페이스를 못 메운다.
--
-- 그럼에도 없애는 이유는 운영 쪽이다: 형운이 **비밀번호를 자주 바꾸는 방식**으로 가기로 했고,
-- 16자를 매번 새로 만들어 세 자리(DB 해시·Edge 시크릿·Apps Script)에 옮기는 일이 회전 자체를
-- 미루게 만든다. 자주 바뀌는 짧은 값과 오래 고정된 긴 값 중 어느 쪽이 나은지는 이 공간의
-- 운영 리듬이 정할 일이고, 그 판단은 형운이 했다.
--
-- ⚠️ **그래서 남는 방어는 시도 제한 하나뿐이다.** 10분/10회(`20260813100000`,
-- `20260814150000`)가 유일한 장벽이 된다. 짧은 값을 쓰기로 했다면 회전 주기를 실제로 지켜야
-- 하고, 특히 **현관 비밀번호와 숫자를 공유하지 않는 값**이어야 한다 — 현관 값은
-- `guest-guide.html`을 통해 사이트에 평문으로 나가므로, 재배열이면 탐색 공간이 순열 수로
-- 줄어든다(7자리 · 숫자 7개 재배열이면 수백 가지다).
--
-- **빈 값은 계속 막는다.** 여기서 통과시키면 `admin_check()`가 빈 문자열끼리 맞아떨어져
-- '누구나 어드민'이 된다. 이 레포는 같은 판단을 이미 세 곳에서 했다 — `CLEANING_TOKEN`
-- 미설정 시 어떤 토큰도 거부(`auth.ts`), `ADMIN_PASSWORD` 미설정 시 전면 503,
-- `_shared/secret.ts`의 상수 시간 비교. '아직 안 심었다'와 '아무나 들어와라'는 다른 뜻이다.
--
-- 값 자체는 여기에 적지 않는다. `20260803000000`이 옛 PIN을 평문으로 커밋해 git 이력에
-- 영구히 남긴 것이 회전이 필요했던 이유였다 — 같은 실수를 반복하지 않는다.
-- 심는 것은 SQL 편집기에서 사람이 한 번: `select public.admin_set_password('<새 값>');`

create or replace function public.admin_set_password(p_password text)
returns void
language plpgsql
security definer
set search_path to public, extensions
as $function$
begin
  if p_password is null or p_password = '' then
    -- 빈 값을 심으면 빈 문자열을 보낸 요청이 통과한다. 길이 바닥은 없애도 이 문은 닫아 둔다.
    raise exception '비밀번호를 비워 둘 수 없습니다';
  end if;

  insert into public.admin_secret (id, pw_hash)
  values (1, crypt(p_password, gen_salt('bf', 12)))
  on conflict (id) do update set pw_hash = excluded.pw_hash, rotated_at = now();
end;
$function$;

comment on function public.admin_set_password(text) is
  '어드민 비밀번호를 심는다(회전 포함). 평문은 저장되지 않는다. 최소 길이 제한 없음(빈 값만 거부, 2026-08-17). 절차는 06-applications/control-setup.md M절.';
