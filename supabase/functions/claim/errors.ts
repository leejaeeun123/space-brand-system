/** 호출측이 HTTP 상태코드로 바꿀 수 있는 오류. `control/handlers/shared.ts`와 같은 역할이다.
 *
 *  거기서 가져다 쓰지 않고 따로 둔 이유는, 그 파일이 ThinQ 클라이언트 팩토리를 함께 들고 있어
 *  import 하는 순간 이 함수와 무관한 냉난방 설정까지 딸려오기 때문이다. */
export class HandlerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HandlerError";
  }
}
