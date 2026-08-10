/**
 * 선정·보류 처리 — 단일 책임: 상태를 바꾸고 결과 문자를 내보낸다.
 *
 * **순서가 계약이다 — 상태 먼저, 문자 나중.** 뒤집으면 문자는 갔는데 상태가 안 바뀐 신청이
 * 생기고, 그건 다음에 또 문자를 보내게 만든다(받는 사람은 두 번 선정된 줄 안다).
 * 반대 방향의 실패(상태는 바뀌고 문자는 못 감)는 장부에 남아 어드민 화면에 드러나므로,
 * 둘 중에는 이쪽이 훨씬 낫다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { type ApplicationForSms, dispatch, type DispatchResult } from "./dispatch.ts";
import type { ApplicationSmsKind } from "./templates.ts";
import { HandlerError } from "./errors.ts";

/** 상태값 = 문자 종류. 둘이 어긋날 이유가 없어 같은 이름을 쓴다. */
export type Decision = ApplicationSmsKind;

async function fetchApplication(sb: SupabaseClient, id: number): Promise<ApplicationForSms> {
  const { data, error } = await sb
    .from("support_applications")
    .select("id,name,phone")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`신청 조회 실패: ${error.message}`);
  if (!data) throw new HandlerError(404, "해당 신청을 찾을 수 없습니다");
  return data as ApplicationForSms;
}

/**
 * 결과를 정하고 문자를 보낸다.
 *
 * 보류였다가 선정되는 경로가 정상이라 **같은 신청을 다시 결정할 수 있다.** 다만 같은 결과를
 * 두 번 정해도 문자는 한 번만 나간다 — 유니크 인덱스가 (application_id, kind)에 걸려 있어
 * `dispatch`가 `already`를 돌려준다.
 */
export async function decide(
  sb: SupabaseClient,
  id: number,
  decision: Decision,
  memo: string,
): Promise<{ status: string; detail?: string; body?: string }> {
  const app = await fetchApplication(sb, id);

  const { error } = await sb
    .from("support_applications")
    .update({
      status: decision,
      decided_at: new Date().toISOString(),
      admin_memo: memo || null,
    })
    .eq("id", id);
  if (error) throw new Error(`상태 변경 실패: ${error.message}`);

  const result: DispatchResult = await dispatch(sb, app, decision);
  return { status: result.status, detail: result.detail, body: result.body };
}
