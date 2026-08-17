-- 어드민 비밀번호를 심을 때 앞뒤 공백을 잘라 저장한다 — 공백-only 값은 빈 값으로 거부.
--
-- 20260817000000이 빈 문자열(`''`)만 막았는데, `' '`(공백 한 칸)이나 개행이 딸린 값은
-- 통과한다. 회전은 복사-붙여넣기로 하는 작업이라(control-setup.md M절의 CLI 경로 포함)
-- 공백이 딸려 들어가는 것이 현실적인 실수이고, 그렇게 심기면 이후 **정확한 값을 입력해도**
-- 'invalid password'가 된다. 그 증상은 세 자리(DB 해시·Edge 시크릿·Apps Script) 동기화
-- 실패(2026-08-14 사고)와 똑같아서, 겪는 사람이 엉뚱한 자리부터 의심하게 된다.
--
-- **심는 쪽에서 자르고, 확인하는 쪽(admin_check)은 건드리지 않는다.** 로그인 입력까지
-- trim하면 '공백이 든 비밀번호'라는 선택지가 아예 없어지는데, 그 선택지를 막는 결정은
-- 값이 태어나는 한 곳에 두는 편이 좁다 — 입력 오타(뒤에 공백)는 로그인 실패로 즉시
-- 보이지만, 심기 오타는 위처럼 며칠짜리 오진이 된다. 비대칭이 맞다.
--
-- 값 자체는 여기에 적지 않는다(20260817000000과 같은 이유 — 20260803000000이 옛 PIN을
-- 평문으로 커밋해 git 이력에 영구히 남긴 것이 회전이 필요했던 이유였다).

create or replace function public.admin_set_password(p_password text)
returns void
language plpgsql
security definer
set search_path to public, extensions
as $function$
declare
  v_password text := btrim(p_password);
begin
  if v_password is null or v_password = '' then
    -- 빈 값을 심으면 빈 문자열을 보낸 요청이 통과한다. 길이 바닥은 없어도 이 문은 닫아 둔다.
    -- btrim 뒤에 재는 것이 이 파일의 요점 — 공백-only도 여기 걸린다.
    raise exception '비밀번호를 비워 둘 수 없습니다 (공백만 있는 값 포함)';
  end if;

  insert into public.admin_secret (id, pw_hash)
  values (1, crypt(v_password, gen_salt('bf', 12)))
  on conflict (id) do update set pw_hash = excluded.pw_hash, rotated_at = now();
end;
$function$;

comment on function public.admin_set_password(text) is
  '어드민 비밀번호를 심는다(회전 포함). 평문은 저장되지 않는다. 앞뒤 공백은 잘라 저장하고 공백-only는 거부(2026-08-18). 최소 길이 제한 없음(2026-08-17). 절차는 06-applications/control-setup.md M절.';
