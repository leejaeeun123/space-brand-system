/**
 * payback_claims 접근 — 단일 책임: 신청을 암호화해 넣고, 처리 결과를 적고, 필요한 한 건만 연다.
 *
 * service_role 키로 붙는다. 테이블은 RLS가 켜져 있고 정책이 하나도 없어 anon 키로는 닿지
 * 않는다 — 이 파일이 유일한 접근 경로다.
 *
 * **평문 주민번호가 이 파일 밖으로 나가지 않는다.** 들어올 때 암호화하고, 나갈 때는
 * `reveal` 한 건만 복호화한다.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { decrypt, encrypt } from "./crypto.ts";
import { HandlerError } from "./errors.ts";
import { maskAccount, maskRrn, type Claim } from "./validate.ts";

export function dbClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/**
 * 접수. 실패하면 던진다 — 삼키면 신청자에게 "접수됐다"고 답하고 아무 데도 안 남는다.
 *
 * 암호화가 저장보다 먼저다. 키가 없으면(`crypto.ts`가 503) **행 자체가 안 생긴다** —
 * 평문이 잠깐이라도 컬럼에 앉았다 나중에 암호화되는 경로를 만들지 않기 위해서다.
 */
export async function insert(sb: SupabaseClient, c: Claim, at: Date): Promise<number> {
  const [rrnEnc, accountEnc] = await Promise.all([encrypt(c.rrn), encrypt(c.account)]);

  const { data, error } = await sb
    .from("payback_claims")
    .insert({
      name: c.name,
      phone: c.phone,
      email: c.email,
      booking_no: c.bookingNo,
      used_on: c.usedOn,
      amount: c.amount,
      bank: c.bank,
      account_holder: c.accountHolder,
      account_enc: accountEnc,
      account_masked: maskAccount(c.account),
      rrn_enc: rrnEnc,
      rrn_masked: maskRrn(c.rrn),
      consented_at: at.toISOString(),
      // 신청자가 보낸 시각이 아니라 접수 시각이다 — 동의 기록과 같은 이유로 우리가 아는 시각이어야 한다.
      review_confirmed_at: c.reviewDone ? at.toISOString() : null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`지원금 신청 저장 실패: ${error.message}`);
  return data.id as number;
}

export async function markNotified(sb: SupabaseClient, id: number, at: Date): Promise<void> {
  const { error } = await sb
    .from("payback_claims")
    .update({ notified_at: at.toISOString() })
    .eq("id", id);
  if (error) console.error(`알림 표시 실패 (id=${id}): ${error.message}`);
}

/**
 * 한 건의 주민번호·계좌번호를 연다. **어드민만, 한 건씩.**
 *
 * 목록에는 절대 쓰지 않는다 — 화면 한 번에 전부 복호화하면 볼 필요가 없는 순간에도 평문이
 * 만들어지고, 그게 로그·메모리·화면 캡처에 남는다.
 *
 * **복호화한 값을 로그에 찍지 않는다.** 디버깅이 편해지는 대신 주민번호가 로그로 샌다.
 */
export async function reveal(
  sb: SupabaseClient,
  id: number,
): Promise<{ rrn: string; account: string }> {
  const { data, error } = await sb
    .from("payback_claims")
    .select("rrn_enc, account_enc, purged_at")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`조회 실패: ${error.message}`);
  if (!data) throw new HandlerError(404, "해당 신청을 찾을 수 없습니다");
  if (!data.rrn_enc || !data.account_enc) {
    throw new HandlerError(410, "이미 파기된 신청이에요 (보유기간 경과 또는 반려)");
  }

  const [rrn, account] = await Promise.all([decrypt(data.rrn_enc), decrypt(data.account_enc)]);
  return { rrn, account };
}

/** 지급 완료 표시. 파기 크론이 매달 곳이 `paid_at`이라, 이걸 안 찍으면 주민번호가 안 지워진다. */
export async function markPaid(sb: SupabaseClient, id: number, at: Date, memo: string) {
  const { error } = await sb
    .from("payback_claims")
    .update({ status: "paid", paid_at: at.toISOString(), admin_memo: memo || null })
    .eq("id", id);
  if (error) throw new Error(`지급 완료 처리 실패: ${error.message}`);
}

/**
 * 반려. **암호문을 그 자리에서 지운다.**
 *
 * 지급하지 않으면 지급명세서도 없고, 그러면 주민번호를 들고 있을 근거가 사라진다.
 * 근거가 사라진 개인정보는 지체 없이 파기해야 하므로 크론을 기다리지 않는다.
 * 행은 남긴다 — 누가 신청했고 왜 반려됐는지는 기록이어야 한다.
 */
export async function reject(sb: SupabaseClient, id: number, at: Date, memo: string) {
  const { error } = await sb
    .from("payback_claims")
    .update({
      status: "rejected",
      rrn_enc: null,
      account_enc: null,
      purged_at: at.toISOString(),
      admin_memo: memo || null,
    })
    .eq("id", id);
  if (error) throw new Error(`반려 처리 실패: ${error.message}`);
}
