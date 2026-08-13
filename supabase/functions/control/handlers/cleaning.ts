/**
 * 현장 QR로 청소 완료를 표시한다 — 판정(`cleaning/completion.ts`)과 DB·알림을 이어 붙인다.
 *
 * 담당자가 청소를 마치고 벽에 붙은 QR을 찍으면, **찍은 시각 이전에 끝난** 예약이 전부
 * 청소 완료가 된다. 어드민에서 한 건씩 누르던 것과 같은 컬럼(`reservations.cleaning_done`)을
 * 쓴다 — 완료 상태가 두 군데로 갈라지면 어느 쪽이 맞는지 아무도 모른다.
 *
 * **`admin_set_cleaning` RPC를 타지 않는다.** 그 함수는 admin 비밀번호를 받는데, 그 값은
 * 예약자 이름·연락처를 여는 `admin_*` RPC의 열쇠이기도 해서 인쇄된 QR에 실을 수 없다.
 * 대신 이 함수가 이미 들고 있는 service_role로 직접 쓴다(`reservation-window.ts`와 같은 방식).
 *
 * 예약에서 읽는 컬럼은 `id`·`date`·`start_time`·`end_time`·`name` 다섯뿐이다. **연락처·이메일·
 * 금액은 읽지 않는다** — 담당자가 "언제 누구 예약을 완료 처리하는가"를 대조하는 데 필요한 건
 * 시각과 이름이고, 나머지는 QR이 인쇄물이라는 사실 앞에서 위험만 남는다.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { kstDay } from "../automation/windows.ts";
import {
  type CompletableReservation,
  type CompletionSummary,
  endedBy,
  summarize,
} from "../cleaning/completion.ts";
import { notifyCompleted, notifyCompleteFailed } from "../cleaning/notify.ts";
import { HandlerError } from "./shared.ts";

/** 판정과 대조에 필요한 것만. 이 목록이 늘어나면 QR 경로가 읽는 개인정보도 같이 늘어난다. */
const FIELDS = "id, date, start_time, end_time, name";

/**
 * `in` 필터 한 번에 넣는 id 수.
 *
 * PostgREST는 필터를 URL 쿼리로 보내므로 uuid 수백 개를 한 줄에 넣으면 요청 줄 길이 제한에
 * 걸린다. 첫 스캔은 밀린 예약이 통째로 들어와 그 수가 클 수 있어 처음부터 나눠 보낸다.
 */
const CHUNK = 100;

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 아직 청소 완료로 표시되지 않은 예약 중 **오늘까지**의 것.
 *
 * 미래 예약은 어차피 `endedBy`가 걸러내지만, 여기서 먼저 좁혀 실어오는 양을 줄인다.
 * 상한을 오늘로 두는 게 안전한 이유는 자정을 넘기는 예약도 `date`는 시작한 날이기 때문이다 —
 * 어제 22시에 시작해 오늘 새벽에 끝나는 예약은 `date`가 어제라 이 조건에 들어온다.
 */
async function fetchOutstanding(sb: SupabaseClient, now: Date): Promise<CompletableReservation[]> {
  const { data, error } = await sb
    .from("reservations")
    .select(FIELDS)
    .eq("cancelled", false)
    .eq("cleaning_done", false)
    .lte("date", kstDay(now))
    .order("date", { ascending: true });
  if (error) {
    console.error("청소 완료 대상 조회 실패", error);
    throw new HandlerError(500, "예약을 불러오지 못했어요");
  }
  return (data ?? []) as CompletableReservation[];
}

/**
 * 지금 찍으면 몇 건이 표시되는가 — **읽기만 한다.**
 *
 * 이 단계를 따로 둔 이유가 둘이다. 하나는 QR 스캐너 앱과 메신저가 링크를 미리 열어보는 일이
 * 있어서, 찍는 것만으로 장부가 바뀌면 안 된다는 것. 다른 하나는 첫 스캔에서 밀린 예약이
 * 수십 건 잡힐 수 있는데, 그걸 **누르기 전에** 숫자로 보여줘야 담당자가 이상하면 멈출 수 있다.
 */
export async function pending(sb: SupabaseClient, now = new Date()): Promise<CompletionSummary> {
  return summarize(endedBy(await fetchOutstanding(sb, now), now));
}

/**
 * 실제로 표시한다.
 *
 * `cleaning_done = false` 조건을 update에도 그대로 건다 — 두 번 연달아 찍혀도 두 번째는
 * 0건이 되고, 같은 예약이 두 번 세어지지 않는다. 돌려받은 행이 **실제로 바뀐 것**이라
 * 알림에 나가는 숫자도 그 값이다(요청한 수가 아니다).
 *
 * 중간에 실패하면 **거기까지 표시된 건수를 알림에 싣고** 오류를 던진다. 롤백하지 않는 이유는
 * 청소가 실제로 끝난 것은 사실이고, 되돌리면 담당자가 한 일이 통째로 사라지기 때문이다.
 */
export async function complete(
  sb: SupabaseClient,
  // 누가 표시했나. 인쇄된 QR은 라운지를 다녀간 누구나 찍을 수 있어, 청소하지 않은 방을
  // 완료로 위조할 수 있다. 막을 방법은 없지만(토큰 하나가 전부다) **누가 눌렀는지는 남긴다** —
  // 안 남기면 잘못된 표시를 사후에 가려낼 단서가 아예 없다.
  source: "admin" | "qr" = "qr",
  now = new Date(),
): Promise<CompletionSummary> {
  const targets = endedBy(await fetchOutstanding(sb, now), now);
  if (targets.length === 0) {
    await notifyCompleted(0, null, null, [], now);
    return summarize([]);
  }

  const changed: CompletableReservation[] = [];
  try {
    for (const ids of chunk(targets.map((r) => r.id), CHUNK)) {
      const { data, error } = await sb
        .from("reservations")
        .update({
          cleaning_done: true,
          cleaning_done_at: now.toISOString(),
          cleaning_done_source: source,
        })
        .in("id", ids)
        .eq("cleaning_done", false)
        .select(FIELDS);
      if (error) throw error;
      changed.push(...((data ?? []) as CompletableReservation[]));
    }
  } catch (e) {
    console.error("청소 완료 표시 실패", e);
    await notifyCompleteFailed(changed.length, e instanceof Error ? e.message : String(e), now);
    throw new HandlerError(500, "일부만 표시됐어요. 어드민에서 확인해 주세요");
  }

  const result = summarize(changed);
  await notifyCompleted(result.count, result.from, result.to, result.items, now);
  return result;
}
