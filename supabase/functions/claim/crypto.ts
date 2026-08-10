/**
 * 주민번호·계좌번호 암복호화 — 단일 책임: 평문과 암호문 사이를 오간다.
 *
 * **DB가 아니라 여기서 암호화하는 이유.** pgcrypto를 쓰면 키가 SQL 문에 실려 쿼리 로그와
 * 에러 메시지에 남을 수 있다. 여기서 하면 DB는 열 수 없는 바이트만 받는다 —
 * **데이터베이스가 통째로 새도 주민번호는 안 새는 것**이 이 파일의 존재 이유다.
 *
 * AES-GCM을 쓴다. 인증 태그가 붙어 있어 암호문이 조작되면 복호화가 실패한다(CBC였다면
 * 조용히 쓰레기를 돌려줬을 것이다).
 */

import { HandlerError } from "./errors.ts";

const ALG = "AES-GCM";
/** GCM 표준 IV 길이. 12바이트가 아니면 성능도 안전성도 손해다. */
const IV_BYTES = 12;

/**
 * 키를 읽는다. **없으면 막는다 — 평문으로 흘려보내지 않는다.**
 *
 * ADMIN_PASSWORD 미설정을 503으로 막는 것과 같은 태도다. 시크릿을 안 넣은 상태는
 * '암호화 없이 받아도 된다'가 아니라 '아직 받을 준비가 안 됐다'이다. 여기서 평문 폴백을
 * 만들면, 시크릿을 빠뜨린 배포 한 번이 주민번호 평문 저장으로 조용히 이어진다.
 */
async function loadKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("RRN_ENCRYPTION_KEY");
  if (!raw) {
    console.error("RRN_ENCRYPTION_KEY 미설정 — 신청을 받지 않습니다");
    throw new HandlerError(503, "서버 설정이 완료되지 않았습니다");
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(raw);
  } catch {
    console.error("RRN_ENCRYPTION_KEY가 base64가 아닙니다");
    throw new HandlerError(503, "서버 설정이 완료되지 않았습니다");
  }

  // AES-256. 길이를 확인하지 않으면 짧은 키가 조용히 들어와 약한 암호가 된다.
  if (bytes.length !== 32) {
    console.error(`RRN_ENCRYPTION_KEY 길이가 32바이트가 아닙니다 (${bytes.length})`);
    throw new HandlerError(503, "서버 설정이 완료되지 않았습니다");
  }

  return await crypto.subtle.importKey("raw", bytes, ALG, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/* `Uint8Array.from(...)`을 쓰지 않는다 — 그건 `Uint8Array<ArrayBufferLike>`를 돌려주는데,
   WebCrypto의 BufferSource는 `ArrayBuffer` 백킹을 요구해서 타입체크가 막힌다.
   버퍼를 명시적으로 잡아 주면 그 모호함이 사라진다. */
function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 암호화. 결과는 `base64(iv ‖ 암호문)`.
 *
 * **IV는 값마다 새로 만든다.** 같은 IV를 재사용하면 GCM은 같은 평문을 같은 암호문으로 만들어,
 * 키가 없어도 '두 사람의 주민번호가 같다'는 사실이 드러난다.
 */
export async function encrypt(plain: string): Promise<string> {
  const key = await loadKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALG, iv }, key, new TextEncoder().encode(plain)),
  );

  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return toBase64(out);
}

/** 복호화. 암호문이 손상됐거나 키가 다르면 예외를 던진다 — 조용히 빈 값을 주지 않는다. */
export async function decrypt(packed: string): Promise<string> {
  const key = await loadKey();
  const bytes = fromBase64(packed);
  if (bytes.length <= IV_BYTES) throw new HandlerError(500, "암호문이 손상됐습니다");

  const iv = bytes.slice(0, IV_BYTES);
  const cipher = bytes.slice(IV_BYTES);
  try {
    const plain = await crypto.subtle.decrypt({ name: ALG, iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    // 키가 회전됐거나 암호문이 조작된 경우다. 어느 쪽이든 사람이 봐야 한다.
    console.error("복호화 실패 — 키가 바뀌었거나 암호문이 손상됐습니다");
    throw new HandlerError(500, "복호화하지 못했습니다");
  }
}
