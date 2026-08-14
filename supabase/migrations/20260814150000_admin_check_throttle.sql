-- 어드민 비밀번호 시도 제한의 네 번째 표면: PostgREST RPC 경로.
--
-- 20260813100000이 만든 시도 제한은 Edge Function 세 곳(control·claim·apply)에만
-- 배선되어 있었다. 그런데 어드민 게이트는 Edge Function이 아니라 PostgREST RPC
-- (`admin_list_reservations` → `admin_check`)를 직접 부른다 — 그 마이그레이션 머리말이
-- "공개 엔드포인트 네 곳"이라 적어둔 그 네 번째가 비어 있었다. 모든 `admin_*` RPC가
-- 비밀번호를 인자로 받으므로 게이트 화면을 고치는 것으로는 부족하고, **검증 뿌리
-- (admin_check)** 에 얹어야 RPC 전체가 한꺼번에 덮인다.
--
-- 키는 Edge와 같은 `cf-connecting-ip`다(#75와 같은 전제 — 클라이언트가 이 헤더를
-- 위조하면 Cloudflare가 요청 자체를 403으로 거부해 위조값이 도달하지 못한다).
-- PostgREST는 요청 헤더를 `request.headers` GUC(JSON, 키는 소문자)로 준다.
--
-- 헤더가 없으면(SQL 편집기·psql·서버측 호출) **세지도 막지도 않는다** — Edge에서
-- "자격증명을 안 보낸 요청은 안 센다"와 같은 태도로, 내부 경로가 스스로 문을 잠그는
-- 실패 모드를 막는다. Edge Function을 거쳐 온 admin_* 호출은 그쪽 throttle이 실제
-- 클라이언트 IP로 이미 세고 있으므로 여기서 이중으로 세지 않는 것이 맞다.
--
-- ⚠️ 이 제한이 라이브에서 실효하려면 해시 전환(20260813111000, control-setup.md M절
--    2~4단계 = 회전)이 끝나 admin_check가 실제 검증 뿌리가 되어 있어야 한다.
--    전환 전 라이브의 평문 비교 함수에는 이 층이 없다 — 회전을 미루는 만큼 이 방어도
--    미뤄진다.

-- ⚠️ `search_path`에 스키마를 두 개 이상 줄 땐 따옴표로 묶지 않는다(20260813110000 실측).
create or replace function public.admin_check(p_password text)
returns void
language plpgsql
security definer
set search_path to public, extensions
as $function$
declare
  stored text;
  v_ip text;
  v_fails int := 0;
begin
  -- PostgREST가 아닌 경로는 request.headers가 없다 → 제한을 건너뛴다.
  begin
    v_ip := nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip';
  exception when others then
    v_ip := null;
  end;

  if v_ip is not null then
    -- fail-open: 장부 조회 실패가 어드민 전면 잠금이 되면 안 된다(_shared/throttle.ts와 같은 태도).
    begin
      select count(*) into v_fails
        from public.auth_attempts
       where ip = v_ip
         and fn = 'rpc'
         and at > now() - interval '10 minutes';
    exception when others then
      v_fails := 0;
    end;

    if v_fails >= 10 then
      -- 문구는 admin.html이 분기해 사람 말로 바꾼다. 'invalid password'와 겹치면 안 된다.
      raise exception 'too many attempts';
    end if;
  end if;

  select pw_hash into stored from public.admin_secret where id = 1;

  if stored is null then
    raise exception 'admin_secret 미설정 — 비밀번호를 심어야 합니다(20260813110000 주석 참조)';
  end if;

  -- crypt(입력, 저장된해시) = 저장된해시  ⇔  입력이 맞다. bcrypt라 비교 자체가 상수 시간이다.
  if crypt(p_password, stored) <> stored then
    if v_ip is not null then
      -- 실패만 센다(20260813100000과 같은 규칙). 기록 실패가 인증 결과를 오염시키면 안 된다.
      begin
        insert into public.auth_attempts (ip, fn) values (v_ip, 'rpc');
      exception when others then
        null;
      end;
    end if;
    raise exception 'invalid password';
  end if;
end;
$function$;

comment on function public.admin_check(text) is
  '어드민 비밀번호 검증의 단일 뿌리. 맞으면 통과, 틀리거나 미설정이면 예외. PostgREST 경유 실패는 IP(cf-connecting-ip)당 10분/10회로 제한한다.';
