/**
 * 결과 안내 문자 한 통을 실제로 내보내는 유일한 경로.
 *
 * `control/sms/dispatch.ts`와 같은 순서를 지킨다: **선점 → 발송 → 기록.**
 * 선점을 발송 뒤로 옮기면 어드민이 버튼을 두 번 눌렀을 때 같은 문자가 두 번 나간다 —
 * 받는 사람은 자기가 두 번 선정된 줄 안다.
 *
 * **SOLAPI 클라이언트는 `control/sms/solapi.ts`를 그대로 쓴다.** 서명·타임아웃·실패 매핑이
 * 이미 실전에서 검증됐고, 복사하면 두 벌이 갈라져 한쪽만 고쳐진다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { loadConfig, normalizePhone, send } from "../control/sms/solapi.ts";
import { type ApplicationSmsKind, render } from "./templates.ts";

export type DispatchStatus =
  /** 실제로 나갔다. */
  | "sent"
  /** 벤더가 거절했거나 못 닿았다. 장부에 사유가 남는다. */
  | "failed"
  /** 이미 보냈거나 다른 호출이 보내는 중. 아무것도 하지 않았다. */
  | "already"
  /** 문자를 받을 수 없는 번호. 사람이 문구를 복사해 보내는 경로로 간다. */
  | "no_phone"
  /** SOLAPI 시크릿이 없다. 장부에 적지 않는다 — 시도조차 못 한 것이라 '실패'와 다르다. */
  | "not_configured";

export interface DispatchResult {
  status: DispatchStatus;
  /** 실패 사유 또는 안내 문구. 어드민이 그대로 보여준다. */
  detail?: string;
  /** 사람이 직접 보낼 때 복사할 본문. no_phone·failed일 때 채운다. */
  body?: string;
}

export interface ApplicationForSms {
  id: number;
  name: string;
  phone: string | null;
}

/**
 * 자리를 선점한다. 유니크 인덱스가 (application_id, kind)에 걸려 있어
 * 두 번째 호출은 여기서 걸린다 — '보내기 전에 이미 보냈나 확인'은 두 호출이 나란히 통과한다.
 *
 * 실패(=이미 있음)를 예외로 올리지 않고 null로 돌려준다. 중복은 오류가 아니라 정상 흐름이다.
 */
async function claim(
  sb: SupabaseClient,
  applicationId: number,
  kind: ApplicationSmsKind,
  to: string | null,
  body: string,
): Promise<number | null> {
  const { data, error } = await sb
    .from("application_sms")
    .insert({
      application_id: applicationId,
      kind,
      status: "sending",
      to_phone: to,
      body,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = unique_violation. 그 외 오류는 진짜 문제라 올린다.
    if (error.code === "23505") return null;
    throw new Error(`문자 장부 기록 실패: ${error.message}`);
  }
  return data.id as number;
}

async function finish(
  sb: SupabaseClient,
  rowId: number,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await sb.from("application_sms").update(patch).eq("id", rowId);
  if (error) console.error(`문자 장부 갱신 실패 (id=${rowId}): ${error.message}`);
}

/**
 * 결과 안내 문자를 보낸다.
 *
 * **문구는 항상 서버가 만든다** — 호출측이 본문을 넘기지 못한다. 그래야 어드민이 미리 본
 * 문장과 실제로 나간 문장이 같다는 것이 구조로 보장된다.
 */
export async function dispatch(
  sb: SupabaseClient,
  app: ApplicationForSms,
  kind: ApplicationSmsKind,
): Promise<DispatchResult> {
  const body = render(kind);
  const cfg = loadConfig();
  if (!cfg) {
    console.warn("SOLAPI 미설정 — 결과 안내 문자를 건너뜁니다");
    return { status: "not_configured", detail: "문자 발송이 설정되지 않았어요", body };
  }

  const to = normalizePhone(app.phone);
  if (!to) {
    // **장부에는 남긴다.** 조용히 넘어가면 '안 보낸 사람'이 어디에도 안 보인다.
    const rowId = await claim(sb, app.id, kind, null, body);
    if (rowId === null) return { status: "already" };
    await finish(sb, rowId, { status: "no_phone", error: "문자를 받을 수 없는 번호" });
    return {
      status: "no_phone",
      detail: "문자를 받을 수 없는 번호예요. 문구를 복사해 직접 보내주세요.",
      body,
    };
  }

  const rowId = await claim(sb, app.id, kind, to, body);
  if (rowId === null) return { status: "already", detail: "이미 보낸 문자예요" };

  const result = await send(cfg, to, body);
  if (!result.ok) {
    await finish(sb, rowId, { status: "failed", error: result.error });
    // 실패해도 본문을 돌려준다 — 사람이 직접 보낼 수 있어야 한다.
    return { status: "failed", detail: result.error, body };
  }

  await finish(sb, rowId, {
    status: "sent",
    sent_at: new Date().toISOString(),
    group_id: result.groupId,
  });
  return { status: "sent" };
}

/**
 * 사람이 직접 보냈다고 표시한다. 실패했거나 번호가 안 되는 건을 장부에서 닫는 유일한 방법이다.
 *
 * 기존 행을 `superseded`로 내리고 새 행을 만든다 — **이미 있는 행을 고쳐 쓰지 않는다.**
 * 그러면 장부가 '실패했는데 성공으로 적힌' 거짓말을 하게 된다(reservation_sms와 같은 규칙).
 */
export async function markManual(
  sb: SupabaseClient,
  app: ApplicationForSms,
  kind: ApplicationSmsKind,
): Promise<void> {
  await sb
    .from("application_sms")
    .update({ status: "superseded" })
    .eq("application_id", app.id)
    .eq("kind", kind)
    .not("status", "in", "(failed,superseded)");

  const { error } = await sb.from("application_sms").insert({
    application_id: app.id,
    kind,
    status: "manual",
    to_phone: normalizePhone(app.phone),
    body: render(kind),
    sent_at: new Date().toISOString(),
  });
  if (error) throw new Error(`수동 발송 표시 실패: ${error.message}`);
}
