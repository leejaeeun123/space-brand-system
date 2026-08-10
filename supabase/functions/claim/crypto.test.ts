/**
 * 암복호화 왕복 테스트. 고정 테스트 키를 환경변수에 넣고 돈다 — 실제 키는 필요 없다.
 *
 * 여기서 지키려는 것은 "암호화가 된다"가 아니라 **"암호문만 보고는 아무것도 못 안다"**이다.
 * 같은 값을 두 번 넣었을 때 같은 암호문이 나오면, 키가 없어도 두 신청자의 주민번호가
 * 같다는 사실이 드러난다.
 */

import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";

// 32바이트(AES-256). 테스트 전용 — 실제 키는 Supabase 시크릿에만 있다.
Deno.env.set("RRN_ENCRYPTION_KEY", btoa("0123456789abcdef0123456789abcdef"));

const { decrypt, encrypt } = await import("./crypto.ts");

Deno.test("암호화한 값을 그대로 되돌린다", async () => {
  const rrn = "990101-1234567";
  assertEquals(await decrypt(await encrypt(rrn)), rrn);
});

Deno.test("암호문에 평문이 남지 않는다", async () => {
  const packed = await encrypt("990101-1234567");
  assertEquals(packed.includes("990101"), false);
  assertEquals(atob(packed).includes("990101"), false);
});

Deno.test("같은 값도 매번 다른 암호문이 된다 — IV를 재사용하지 않는다", async () => {
  const a = await encrypt("990101-1234567");
  const b = await encrypt("990101-1234567");
  assertNotEquals(a, b);
  // 그래도 둘 다 같은 값으로 돌아와야 한다.
  assertEquals(await decrypt(a), await decrypt(b));
});

Deno.test("조작된 암호문은 복호화되지 않는다 — 조용히 쓰레기를 주지 않는다", async () => {
  const packed = await encrypt("990101-1234567");
  const bytes = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff; // 마지막 바이트를 뒤집는다
  let tampered = "";
  for (const b of bytes) tampered += String.fromCharCode(b);
  await assertRejects(() => decrypt(btoa(tampered)));
});

Deno.test("키가 없으면 암호화 자체를 거부한다 — 평문 폴백이 없다", async () => {
  const saved = Deno.env.get("RRN_ENCRYPTION_KEY")!;
  Deno.env.delete("RRN_ENCRYPTION_KEY");
  try {
    await assertRejects(() => encrypt("990101-1234567"));
  } finally {
    Deno.env.set("RRN_ENCRYPTION_KEY", saved);
  }
});

Deno.test("키 길이가 32바이트가 아니면 거부한다", async () => {
  const saved = Deno.env.get("RRN_ENCRYPTION_KEY")!;
  Deno.env.set("RRN_ENCRYPTION_KEY", btoa("too-short"));
  try {
    await assertRejects(() => encrypt("990101-1234567"));
  } finally {
    Deno.env.set("RRN_ENCRYPTION_KEY", saved);
  }
});
