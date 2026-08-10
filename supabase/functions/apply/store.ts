/**
 * support_applications 접근 — 단일 책임: 신청을 장부에 넣고, 알림이 나간 것을 표시한다.
 *
 * service_role 키로 붙는다. 테이블은 RLS가 켜져 있고 정책이 하나도 없어 anon 키로는 읽지도
 * 쓰지도 못한다(마이그레이션 주석 참조) — **이 파일이 유일한 접근 경로다.**
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Application } from "./validate.ts";

export function dbClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/**
 * 접수. 실패하면 던진다 — 여기서 삼키면 신청자에게 "접수됐다"고 답하고 아무 데도 안 남는다.
 *
 * `consented_at`은 **서버 시각으로 찍는다.** 클라이언트가 보낸 시각은 신뢰할 수 없고,
 * 동의 기록은 나중에 입증에 쓰이는 값이라 우리가 아는 시각이어야 한다.
 */
export async function insert(
  sb: SupabaseClient,
  app: Application,
  at: Date,
): Promise<number> {
  const { data, error } = await sb
    .from("support_applications")
    .insert({ ...app, consented_at: at.toISOString() })
    .select("id")
    .single();

  if (error) throw new Error(`신청 저장 실패: ${error.message}`);
  return data.id as number;
}

/**
 * 알림이 나갔음을 표시한다. **여기서 실패해도 접수는 유효하다** — 표시가 못 붙으면 나중에
 * '알림 못 간 건'으로 한 번 더 보일 뿐이고, 그건 반대(못 갔는데 갔다고 적힘)보다 훨씬 낫다.
 */
export async function markNotified(
  sb: SupabaseClient,
  id: number,
  at: Date,
): Promise<void> {
  const { error } = await sb
    .from("support_applications")
    .update({ notified_at: at.toISOString() })
    .eq("id", id);

  if (error) console.error(`알림 표시 실패 (id=${id}): ${error.message}`);
}
