-- 자동 문자 재시도가 '확정 거절'과 '결과 불명'을 구분하게 한다.
--
-- sms/solapi.ts의 send()는 지금까지 타임아웃·네트워크 예외·5xx를 벤더의 확정 거절(4xx·
-- failedMessageList)과 **같은 실패**로 뭉갰다. sms/dispatch.ts가 그걸 'failed'로 적고,
-- 20260808100000의 부분 유니크(reservation_sms_once)가 'failed'를 자리에서 빼므로 다음 틱이
-- 재발송한다. 벤더가 수신했는데 응답만 유실된 경우 **유료 LMS가 손님에게 중복 도달**한다.
--
-- 고침: 결과 불명은 새 상태 'unknown'으로 적는다. 벤더가 처리했을 수 있으니 자동 재시도를
-- 멈추고(자리를 막는다), 사람이 SOLAPI 콘솔에서 확인해 어드민 재발송(supersede)으로 푼다.
-- 확정 거절(4xx·건별 거절)만 'failed'로 남겨 자동 재시도를 유지한다.
--
-- **유니크 인덱스는 건드리지 않는다.** reservation_sms_once의 조건자는
-- `status not in ('failed', 'superseded')` — 자리를 **비우는** 상태의 제외 목록이다. 'unknown'은
-- 이 목록에 없으므로 별도 처리 없이 자동으로 자리를 막는다(= 다음 틱의 선점 INSERT가 유니크
-- 위반으로 막혀 재발송이 안 나간다). 인덱스를 다시 만드는 것은 의미 변화 0에 라이브 테이블
-- 락만 만드는 위험이라 하지 않는다.
--
-- drop constraint를 조건 없이 한다 — `if exists`로 두면 이름이 다를 때 조용히 넘어가고 뒤이은
-- add가 성공해 옛 제약이 남는 가장 나쁜 실패가 된다(20260812130000의 선례를 따른다).
alter table public.reservation_sms drop constraint reservation_sms_status_check;
alter table public.reservation_sms add constraint reservation_sms_status_check
  check (status in (
    'sending', 'sent', 'failed', 'unknown', 'no_phone', 'manual', 'expired', 'superseded'
  ));

comment on column public.reservation_sms.status is
  'sending=선점만 하고 발송 중 · sent=발송됨 · failed=벤더가 확정 거절(4xx·건별 거절, 재시도 가능) · unknown=결과 불명(타임아웃·네트워크 예외·5xx — 벤더가 받았을 수 있어 자리를 막는다, 사람이 SOLAPI 콘솔 확인 후 어드민 재발송) · no_phone=자동발송은 켜져 있는데 연락처가 없어 못 보냄 · manual=번호가 없어 사람이 직접 보냄 · expired=창을 놓쳐 안 보냄 · superseded=뒤에 재발송으로 대체됨. sending인 채 오래 남아 있으면 함수가 발송 도중에 죽은 것이다.

unknown이 failed와 따로 있는 이유: failed는 유니크 인덱스 밖이라 다음 틱이 곧바로 다시 시도하는데, 결과 불명 상태에서 재시도하면 벤더가 이미 처리한 유료 문자를 손님에게 두 번 보낼 수 있다. unknown은 자리를 막아 자동 재시도를 멈춘다.';
