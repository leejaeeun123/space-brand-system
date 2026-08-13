-- 청소 완료 표시의 출처를 남긴다.
--
-- 인쇄된 QR은 누구나 찍을 수 있어 청소 안 한 방을 완료로 위조할 수 있는데, 지금은 표시 주체를
-- 안 남겨 사후에 가려낼 수 없다. handlers/cleaning.ts의 complete()가 이 두 컬럼을 채운다.
--
-- cleaning_done_source:
--   'qr'    = 현장 인쇄 QR(cleaning-done.html, cleaner 토큰) — 위조 가능 경로
--   'admin' = 어드민(admin.html, 비밀번호) — 신뢰 경로
-- null = 이 마이그레이션 이전에 표시됐거나, admin_set_cleaning RPC(어드민 한 건씩 토글)로
--        표시된 것 — 그 RPC 경로는 아직 출처를 안 남긴다(후속 과제).
--
-- cleaning_done 컬럼 자체는 마이그레이션에 정의가 없다(라이브 스키마에만 존재) — 그래서 여기서
-- 새 컬럼만 add 한다. check가 null을 통과하므로 기존 행은 그대로 유효하다.

alter table public.reservations
  add column if not exists cleaning_done_at timestamptz;
comment on column public.reservations.cleaning_done_at is
  '청소 완료로 표시한 시각. null = cleaning_done=false이거나 이 컬럼 도입 이전에 표시됨.';

alter table public.reservations
  add column if not exists cleaning_done_source text
  check (cleaning_done_source in ('admin', 'qr'));
comment on column public.reservations.cleaning_done_source is
  '완료 표시 주체. qr=현장 인쇄 QR(위조 가능), admin=어드민 비밀번호(신뢰). null=미상/레거시(admin_set_cleaning RPC 경로 포함).';
