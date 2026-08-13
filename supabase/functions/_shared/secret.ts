/**
 * 비밀값 비교 — 세 함수(control·claim·apply)가 같은 방식으로 비교하게 한다.
 *
 * 원래 이 레포는 admin 비밀번호에 상수 시간 비교를 **일부러 안 썼다**. 근거가 명확했다:
 * 같은 값이 `admin_*` SQL 함수에서 평문 `<>`로도 비교되니 한 곳만 조여봐야 실제로 막히는 게
 * 없다는 것이었다(control/auth.ts 주석). 그 전제는 `admin_check()` 해시 검증
 * (마이그레이션 20260813110000)이 들어오면서 사라졌다 — 이제 SQL 쪽도 bcrypt로 비교하므로
 * 여기서 새는 것을 막을 이유가 생겼다.
 */

/**
 * 두 문자열이 같은가. 내용에 대해 상수 시간이다.
 *
 * **길이가 달라도 조기 반환하지 않는다.** 길이 불일치를 빨리 돌려주면 비밀번호 길이를 재는
 * 채널이 열린다. 대신 긴 쪽 길이만큼 항상 돌면서 길이 차이도 누산기에 섞는다.
 *
 * 바이트가 아니라 코드유닛으로 비교한다 — 자격증명은 ASCII라 차이가 없고,
 * `TextEncoder`를 매번 만들지 않아도 된다.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  // 길이가 다르면 이 값이 0이 아니고, 아래 루프 결과와 함께 최종 판정에 들어간다.
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    // 범위를 벗어난 인덱스는 0으로 읽는다 — 짧은 쪽에서 루프를 일찍 끝내지 않으려는 것이다.
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
