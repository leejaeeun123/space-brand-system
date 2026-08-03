-- 같은 예약번호가 중복 등록되는 것을 DB 레벨에서 막는 안전장치.
-- booking_no가 없는 수동 입력(전화 예약 등)은 null이라 제약 대상에서 제외됨.
create unique index if not exists reservations_booking_no_uidx
  on public.reservations (booking_no)
  where booking_no is not null;
