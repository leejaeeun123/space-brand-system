/**
 * 예정된 전환 — 단일 책임: 입실 준비와 퇴실 종료를 기기 명령으로 옮긴다.
 *
 * '언제인가'는 `windows.ts`가, '무엇을 기록하는가'는 `store.ts`가 안다. 여기는 '무엇을 보내는가'만.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { list } from "../handlers/list.ts";
import { issue } from "./dispatch.ts";

type DeviceList = Awaited<ReturnType<typeof list>>["devices"];
type Device = DeviceList[number];

/** 입실 준비 온도. **하한(`enforce.ts`의 24도)보다 높아야 한다** — 낮게 잡으면 준비하자마자
 *  하한 강제가 되돌려 두 자동화가 서로 싸운다. */
const PREP_TEMP = 26;
/** 준비 모드는 반드시 냉방이다(형운 지시, 2026-08-07). */
const PREP_MODE = "COOL";

/* DB에는 kind='light'만 있고 벤더 구분이 없다 — `admin.html`·`guest-control.html`과 같은 표식
   (형운 확인, 2026-08-04). 세 곳 중 하나만 바꾸면 나이트모드가 서로 다르게 동작한다. */
function isSihasLight(name: string): boolean {
  return /sihas/i.test(name);
}

/**
 * 냉난방 준비 — 전원 → 모드 → 온도 **순서대로**.
 *
 * 한 기기에 동시에 쏘지 않는 이유: 모드를 바꾸면 목표온도가 기기 기본값으로 되돌아가는 기종이
 * 있어, 온도를 모드보다 먼저(또는 동시에) 보내면 26도가 조용히 지워진다.
 */
async function prepareHvac(sb: SupabaseClient, d: Device): Promise<void> {
  if (d.capabilities.includes("power")) {
    await issue(sb, { device_id: d.id, command: "power_on" }, "prep");
  }
  if (d.capabilities.includes("mode")) {
    const modes = d.constraints?.modes ?? [];
    if (modes.includes(PREP_MODE)) {
      await issue(sb, { device_id: d.id, command: "set_mode", value: PREP_MODE }, "prep");
    } else {
      // 냉방은 요구사항이라 조용히 넘기지 않는다 — 프로파일에 없다면 실기기 등록이 잘못됐거나
      // 기기가 바뀐 것이고, 사람이 봐야 한다.
      console.error("냉방 모드가 기기 프로파일에 없다 — 모드 지정을 건너뛴다", d.id, modes);
    }
  }
  if (d.capabilities.includes("temp")) {
    await issue(sb, { device_id: d.id, command: "set_temp", value: PREP_TEMP }, "prep");
  }
}

/** 입실 준비 — 냉난방은 26도·냉방으로, 조명은 나이트모드와 같은 SiHAS on/off 조합. */
export async function firePrep(sb: SupabaseClient, devices: DeviceList): Promise<void> {
  // 기기끼리는 병렬, 한 기기 안에서는 순차. 일부가 실패해도 나머지는 계속 보낸다 —
  // `admin.html`/`guest-control.html`의 runCommands와 같은 규칙(반쯤 준비된 채 포기하지 않는다).
  const jobs: Array<Promise<unknown>> = [];
  for (const d of devices) {
    if (d.kind === "hvac") {
      jobs.push(prepareHvac(sb, d));
    } else if (d.kind === "light") {
      jobs.push(issue(sb, {
        device_id: d.id,
        command: isSihasLight(d.name) ? "power_off" : "power_on",
      }, "prep"));
    }
  }

  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "rejected") console.warn("입실 준비 — 기기 명령 실패", r.reason);
  }
}

/** 퇴실 — 전원 조작이 가능한 기기를 전부 끈다. */
export async function fireShutdown(sb: SupabaseClient, devices: DeviceList): Promise<void> {
  const targets = devices.filter((d) => d.capabilities.includes("power"));
  const results = await Promise.allSettled(
    targets.map((d) => issue(sb, { device_id: d.id, command: "power_off" }, "shutdown")),
  );
  for (const r of results) {
    if (r.status === "rejected") console.warn("퇴실 종료 — 기기 명령 실패", r.reason);
  }
}
