/**
 * 문자 action — 어드민이 부르는 표면. 실제 발송 규칙은 `sms/dispatch.ts`가 갖는다.
 *
 * 여기가 하는 일은 셋뿐이다: 입력을 검증하고, 예약을 읽고, 결과를 HTTP로 번역한다.
 * **손님은 이 파일에 닿지 못한다** — `auth.ts`의 `GUEST_ACTIONS`에 아무것도 넣지 않아
 * 손님 요청은 라우팅 전에 403으로 잘린다. 미리보기까지 admin 전용인 이유는 문구에
 * 예약 일시가 들어가고, 그것이 곧 '언제 그 공간이 비는가'라는 정보이기 때문이다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { HandlerError } from "./shared.ts";
import { targetTime } from "../automation/windows.ts";
import { dispatch, markExpired, markManual, type SmsReservation, supersede } from "../sms/dispatch.ts";
import { KIND_LABEL, kindsFor, render, SMS_KINDS, type SmsKind } from "../sms/templates.ts";
import { loadConfig } from "../sms/solapi.ts";

/** 문자에 필요한 필드 + 보내도 되는지 판단할 필드(`cancelled`). */
const FIELDS = "id,name,phone,date,start_time,end_time,deposit_required,sms_auto,cancelled";

interface ReservationRow extends SmsReservation {
  sms_auto: boolean;
  cancelled: boolean;
}

function parseId(body: Record<string, unknown>): string {
  const id = String(body.reservation_id ?? "").trim();
  if (!id) throw new HandlerError(400, "reservation_id가 필요합니다");
  return id;
}

function parseKind(body: Record<string, unknown>): SmsKind {
  const kind = String(body.kind ?? "");
  if (!SMS_KINDS.includes(kind as SmsKind)) {
    throw new HandlerError(400, `알 수 없는 문자 종류: ${kind}`);
  }
  return kind as SmsKind;
}

async function fetchReservation(sb: SupabaseClient, id: string): Promise<ReservationRow> {
  const { data, error } = await sb.from("reservations").select(FIELDS).eq("id", id).maybeSingle();
  if (error) throw new HandlerError(500, `예약 조회 실패: ${error.message}`);
  if (!data) throw new HandlerError(404, "예약을 찾을 수 없습니다");
  return data as unknown as ReservationRow;
}

/**
 * 이 예약에 이 문자를 보내도 되는가.
 *
 * 취소된 예약은 **어드민이 눌러도** 막는다. 손이 미끄러졌을 때 "곧 입실 시간이네요"가
 * 취소한 손님에게 가는 것은 되돌릴 수 없다 — 클라이언트에서 버튼을 감추는 것만으로는
 * 부족하다는 이 레포의 판단이 여기에도 그대로 적용된다.
 */
function assertSendable(r: ReservationRow, kind: SmsKind): void {
  if (r.cancelled) throw new HandlerError(400, "취소된 예약에는 문자를 보내지 않습니다");
  if (!kindsFor(r).includes(kind)) {
    throw new HandlerError(
      400,
      `이 예약에는 '${KIND_LABEL[kind]}'가 없습니다 (보증금 설정을 확인하세요)`,
    );
  }
}

/** 복사용 문구. 번호가 없어도 부를 수 있어야 한다 — 그게 이 action의 존재 이유다. */
export async function preview(sb: SupabaseClient, body: Record<string, unknown>) {
  const kind = parseKind(body);
  const r = await fetchReservation(sb, parseId(body));
  assertSendable(r, kind);
  return { kind, label: KIND_LABEL[kind], text: render(kind, r) };
}

/**
 * 한 통 보낸다. `resend: true`면 기존 기록을 물러나게 하고 다시 보낸다.
 *
 * 실패를 200으로 돌려준다 — 어드민이 그 자리에서 '복사해서 직접 보내기'로 갈아탈 수 있어야
 * 하는데, HTTP 오류로 던지면 화면이 그냥 "실패했어요"에서 멈춘다. 시크릿 미설정만 예외로
 * 503을 던진다: 그건 이 예약의 문제가 아니라 서버가 아직 못 보내는 상태라는 뜻이다.
 */
export async function sendOne(sb: SupabaseClient, body: Record<string, unknown>) {
  if (!loadConfig()) {
    throw new HandlerError(503, "문자 서비스 미설정 — SOLAPI_API_KEY·SOLAPI_API_SECRET·SOLAPI_SENDER 필요");
  }
  const kind = parseKind(body);
  const r = await fetchReservation(sb, parseId(body));
  assertSendable(r, kind);

  if (body.resend === true) await supersede(sb, r.id, kind);

  const result = await dispatch(sb, r, kind, "admin");
  return { kind, ...result };
}

/** 번호가 없어 사람이 문자 앱으로 보낸 것을 장부에 남긴다. */
export async function markManualSent(sb: SupabaseClient, body: Record<string, unknown>) {
  const kind = parseKind(body);
  const r = await fetchReservation(sb, parseId(body));
  assertSendable(r, kind);

  if (body.resend === true) await supersede(sb, r.id, kind);

  const recorded = await markManual(sb, r, kind);
  return { kind, status: recorded ? "manual" : "already" };
}

/**
 * 자동발송을 켜고 끈다. **켤 때는 첫 통이 같은 클릭 안에서 나간다.**
 *
 * SQL RPC로 두지 않은 이유가 이것이다(마이그레이션 20260808100000 설계 4번). 보증금 안내와
 * 예약 확정은 '예약 접수 시점'에 나가야 하는 문자인데, 자동 스윕은 예약 전후 1일치만 훑으므로
 * (`store.fetchRecent`) 다음 주 예약에 오늘 켜면 그 문자가 예약 당일에야 나간다.
 *
 * 첫 통이 실패해도 플래그는 켜진 채로 둔다 — 시각 기반 문자(입실·퇴실)는 계속 나가야 하고,
 * 실패한 한 통은 어드민에서 다시 보내면 된다. 결과를 그대로 돌려주므로 화면이 조용하지 않다.
 *
 * **이미 입실 시각이 지났으면 그 첫 통을 보내지 않는다.** 보증금 안내와 예약 확정 안내는
 * 예약이 시작되기 **전에**만 의미가 있는 문자다 — 다섯 시간 전에 들어온 손님에게
 * "예약 확정되었습니다! 입실 10분 전에 이용 안내 문자 다시 보내드릴게요"가 가면 안 된다.
 * 이 경우는 조용히 건너뛰지 않고 `expired`로 남긴다(창을 놓친 게 사실이다). 그래야 이후
 * 퇴실 안내는 정상적으로 나가면서, 화면과 채널에는 이 한 통이 안 나갔다는 게 남는다.
 *
 * 이용 중인 예약에 뒤늦게 연락처를 넣고 자동발송을 켜는 것이 실제 사용 흐름이라
 * (2026-08-08 형운) 이 분기는 예외 상황이 아니라 정상 경로다.
 */
export async function setAuto(sb: SupabaseClient, body: Record<string, unknown>) {
  const id = parseId(body);
  const value = body.value === true;
  const r = await fetchReservation(sb, id);

  if (value && r.cancelled) {
    throw new HandlerError(400, "취소된 예약에는 자동발송을 켤 수 없습니다");
  }

  const { error } = await sb.from("reservations").update({ sms_auto: value }).eq("id", id);
  if (error) throw new HandlerError(500, `자동발송 설정 실패: ${error.message}`);

  if (!value) return { sms_auto: false, immediate: null };

  const kind: SmsKind = r.deposit_required ? "deposit" : "confirm";

  if (new Date() >= targetTime(r.date, r.start_time)) {
    const recorded = await markExpired(sb, r, kind);
    return { sms_auto: true, immediate: { kind, status: recorded ? "expired" : "already" } };
  }

  const result = await dispatch(sb, r, kind, "admin");
  return { sms_auto: true, immediate: { kind, ...result } };
}
