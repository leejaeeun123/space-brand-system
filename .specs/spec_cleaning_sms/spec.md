# spec_cleaning_sms

> 청소 담당자에게 매일 아침 **당일 예약 스케줄과 청소 가능 구간**을 문자로 보내고, 그 뒤 스케줄이
> 바뀌면 변경 안내를 보내는 기능. 같은 내용이 Mattermost에도 올라가 형운이 문자 없이 같은 걸 본다.

## 1. 개요

타입라운지는 무인 운영이라 청소 담당자가 "오늘 언제 들어가면 되는지"를 알 방법이 없다. 예약은
스페이스클라우드에서 수시로 들어오고 취소·연장도 생기는데, 그걸 담당자에게 전하는 경로가 지금은
사람뿐이다.

이 기능은 두 통의 문자를 만든다.

| 문자 | 언제 | 무엇을 |
|---|---|---|
| **다이제스트** | 매일 07:00 KST (늦어도 22:00까지) | 당일 예약 목록 + 청소 가능 구간. 예약이 0건이어도 보낸다 |
| **변경 안내** | 다이제스트 발송 후 ~ 22:00 KST 사이, 당일 스케줄이 바뀔 때마다 | 추가·취소·시간변경 + **변경 후 청소 구간 재계산** |

핵심 동작 세 가지:

1. **새 크론을 만들지 않는다.** pg_cron이 1분마다 찌르는 기존 `automate` 액션에 스윕을 하나 더
   얹는다. 예약 변경은 스클 파트너 API·Gmail 동기화·어드민·`admin_set_time` 어디로 들어오든
   전부 `reservations` 테이블 한 곳으로 모이므로, **틱마다 오늘 스케줄을 직전 스냅샷과 비교**하면
   변경 감지가 훅 없이 된다.
2. **청소 창은 예약 사이 공백에서 계산한다.** 공백이 30분 이상이면 청소 가능 구간, 미만이면
   "연달림 — 청소 시간 없음" 경고로 적는다.
3. **문자와 Mattermost가 같은 본문을 쓴다.** 담당자는 문자로, 형운은 채널로 같은 것을 본다.

### 이 스펙이 하지 않는 것 (Non-Requirements)

| 안 하는 것 | 사유 |
|---|---|
| 청소 완료 회신·확인 경로 | 어드민에 이미 `cleaning_done` 체크 버튼이 있다(`admin.html:899`). 이번 범위에서 유예 |
| 어드민 수신자 관리 UI | 수신자는 시크릿 하나다. 화면을 만들 만큼의 변동이 없다 |
| 다이제스트 수동 재발송 버튼 | 실패해도 Mattermost에 본문이 그대로 남아 정보가 유실되지 않는다. SQL 한 줄로 푸는 절차만 문서화한다 |
| 손님에게 나가는 문구 변경 | `sms/templates.ts`는 손대지 않는다 |
| 내일 이후 스케줄 안내 | "당일"만 다룬다 |

## 기술 스택

프로젝트 공통(Supabase Edge Function `control` · Deno · supabase-js v2 from jsr · PostgreSQL)
+ 이 스펙 고유:

- **SOLAPI Messages v4** `POST /messages/v4/send-many/detail`, `type: "LMS"` — 기존
  `sms/solapi.ts`의 `loadConfig`·`normalizePhone`·`send`를 **그대로 재사용한다**(새 클라이언트를
  만들지 않는다).
- **pg_cron / pg_net** — 기존 `reservation-automation` 잡(1분 주기)을 재사용한다. **신규 잡 없음.**
- **Mattermost 인커밍 웹훅** — `MATTERMOST_SMS_WEBHOOK_URL ?? MATTERMOST_WEBHOOK_URL` 순서로
  고르는 기존 `sms/notify.ts`와 같은 규칙.

## 실행 환경

- Supabase Edge Function `control` (Deno Deploy). **런타임 타임존은 UTC다** — KST 시각 계산은
  전부 `automation/windows.ts`(명시 `+09:00` 오프셋)를 통한다.
- pg_cron 1분 주기 → `{"action":"automate"}`.
- 배포: `supabase db push` → `supabase functions deploy control`.
- CI: `.github/workflows/test.yml`이 `supabase/**` 변경 시 `deno lint` · `deno check` ·
  `deno test --allow-env`를 돌린다. `deno check`의 진입점(`handlers/*.ts`)에서 임포트가 따라가므로
  **워크플로 수정은 필요 없다.**

## 2. 접근 제어

**손님도 어드민도 이 기능을 부르지 못한다.** 새 action을 만들지 않기 때문이다 — 유일한 진입점은
pg_cron이 찌르는 기존 `automate`이고, 그 안에서 서버가 스스로 시각을 보고 판단한다. 호출자가
수신자·날짜·내용 어느 것도 고르지 못하므로 `auth.ts`에 새로 열 권한이 없다.

`cleaning_sms` 테이블은 RLS를 켜고 **정책을 하나도 두지 않는다** — anon·authenticated는 전부
막히고 Edge Function의 service_role만 닿는다(`reservation_sms`와 같은 방식).

## 3. 청소 창 계산 (이 기능의 핵심 로직)

### 대상 예약

`automation/store.ts`의 `fetchRecent`가 이미 실어오는 배열(어제~내일 KST · `cancelled = false`)에서
**오늘에 해당하는 것만** 고른다.

| 포함 | 사유 |
|---|---|
| `r.date === kstDay(now)` | 오늘 예약 |
| `r.date`는 어제인데 `endTime(r)`이 오늘 안 | **자정을 넘긴 예약**(22:00~02:00 등). 오늘 새벽까지 공간이 쓰였으므로 첫 청소 창의 시작을 민다 |

`endTime()`을 **반드시 통과한다.** 직접 `targetTime(r.date, r.end_time)`을 쓰면 자정을 넘기는
예약의 종료가 시작보다 이르게 나온다 — 이 레포가 이미 겪은 버그다(#41 · `windows.ts` 주석).

### 구간 나누기

시작 시각(`targetTime`) 오름차순 정렬 후, 경계를 이렇게 잡는다.

```
   ┌── 하루 시작 경계 = 넘어온 예약의 endTime (없으면 오늘 00:00)
   │
   ▼
  00:00 ──────── 09:00 ══════ 12:00 ──── 13:00 ══════ 17:00 ─ 17:20 ═════ 20:00 ────▶
        청소 창          예약①        청소 창       예약②    │      예약③     청소 창
                                     (60분)              20분          (끝 경계 없음)
                                                        연달림 경고
```

| 구간 | 시작 | 끝 |
|---|---|---|
| 첫 구간 | 넘어온 예약 `endTime` (없으면 오늘 00:00) | 첫 예약 `start` |
| 사이 구간 | 앞 예약 `endTime` | 뒤 예약 `start` |
| 마지막 구간 | 마지막 예약 `endTime` | **없음** ("이후"로 적는다) |

- 길이 **≥ 30분** → 청소 창
- 길이 **< 30분** → 연달림 경고 (음수·0 포함 — 단일 공간이라 겹칠 일은 없지만 방어적으로 0으로 본다)
- 예약이 0건 → 청소 창 하나, 시작·끝 없음 ("오늘 언제든")

### 이미 지난 창은 싣지 않는다

**30분 판정은 원래 간격으로 하고, 문자에 싣는 것은 `now` 이후에 남아 있는 창만이다.**

| 창과 `now`의 관계 | 문자에 |
|---|---|
| 창이 `now` 전에 이미 끝남 | **뺀다** |
| 창이 진행 중 | 시작을 '지금'으로 당긴다 — `12:20–13:00 (40분)` |
| 진행 중인데 30분도 안 남음 | **뺀다.** 경고로 바꾸지 않는다 — 실행할 수 없는 안내를 적으면 문자 전체의 신뢰가 깎인다 |
| 창이 아직 안 옴 | 그대로 |

07:00 다이제스트에서 첫 구간이 `00:00~09:00`이면 `07:00~09:00`으로 잘려 나간다. 이 규칙이
없으면 (a) 늦게 나간 다이제스트가 이미 지난 시각을 청소 가능이라고 말하고, (b) 오후에 나가는
변경 안내가 매번 오전 창부터 다시 나열한다.

두 판정을 나누는 이유: `now`로 자른 뒤에 30분을 재면 **오전에 지나간 긴 창이 '10분짜리'로 보여
연달림 경고로 둔갑한다.** 연달림 경고는 스케줄의 성질이지 지금 몇 시인가의 문제가 아니다.

### 날짜 넘김 표기

마지막 예약이 자정을 넘겨 끝나면(예: 22:00~02:00) 마지막 청소 창은 **다음 날**이다. 시각만
적으면 "02:00 이후"가 오늘 새벽으로 읽히므로 `내일 02:00 이후`로 적는다.

## 4. 문자 문구

문구 정본은 `cleaning/templates.ts`다. 손님 문자(`sms/templates.ts`)와 **파일을 나눈다** —
수신자도 톤도 담는 정보도 다르고, 한 파일에 두면 손님 문구를 고치다 담당자 문구가 같이 움직인다.

### 다이제스트

```
[타입라운지] 8/9(일) 청소 안내

■ 오늘 예약 3건
09:00–12:00 김민수 6명 · 회의
13:00–17:00 윤단비 8명 · 파티룸
17:20–20:00 이지훈 4명

■ 청소 가능
07:00–09:00 (120분)
12:00–13:00 (60분)
20:00 이후

⚠️ 17:00→17:20은 20분이라 청소 시간이 없어요
```

어제에서 넘어온 예약(자정 넘김)은 **목록에 `(어제)`를 붙여 싣는다.** 창 계산에 영향을 줬는데
목록에 없으면 담당자가 "왜 첫 청소 창이 이 시각부터지?"를 알 수 없다.

```
■ 오늘 예약 2건
(어제) 22:00–02:00 김민수 6명
14:00–18:00 윤단비 8명 · 회의
```

예약 0건인 날:

```
[타입라운지] 8/9(일) 청소 안내

오늘 예약이 없어요. 청소는 편한 시간에 하시면 됩니다.
```

### 변경 안내

12:30에 나가는 변경 안내 예시:

```
[타입라운지] 8/9(일) 예약 변경

+ 추가  20:00–22:00 박서준 5명 · 촬영
− 취소  09:00–12:00 김민수
↻ 변경  13:00–17:00 → 13:00–19:00 윤단비

■ 청소 가능 (변경 후)
12:30–13:00 (30분)
19:00–20:00 (60분)
22:00 이후
```

변경 안내에 청소 창을 **다시 싣는다.** 담당자가 실제로 행동하는 값이 그것이라, "예약이 하나
늘었어요"만 보내면 담당자가 머릿속으로 다시 계산해야 한다. 첫 줄이 `12:30`부터인 것은
이미 12:30이라 `remaining`이 그 창의 시작을 당겼기 때문이다(§3).

### 담는 정보

| 필드 | 담나 | 비고 |
|---|:---:|---|
| 시각 | 담는다 | |
| 예약자 이름 (`name`) | 담는다 | 형운 결정 2026-08-09 |
| 인원 (`guests`) | 담는다 | 값이 없으면 그 조각만 뺀다 |
| 용도 (`purpose`) | 담는다 | **자주 비어 있다** — Gmail 동기화 경로가 항상 null로 넣는다(`spacecloud-gmail-sync.gs:193`, 메일 본문에 없음). 파트너 API 동기화를 사람이 돌린 예약에만 값이 있다. 없으면 그 조각만 뺀다 |
| 연락처 (`phone`) | 안 담는다 | 청소에 필요 없다. 성공 알림에서 번호를 빼는 `sms/notify.ts`와 같은 기준 |
| 메모·요청사항 (`memo`) | 안 담는다 | 손님이 자유 입력한 값이라 무엇이 들어올지 모른다 |

**청소 담당자는 내부 인력이다**(형운 확인 2026-08-09). 그래서 「개인정보 보호법」 §26의
처리위탁이 아니라 같은 개인정보처리자 안의 **개인정보취급자**(§28)이고, 위탁 사실을 따로
공개할 의무가 없다. 예약자 이름·인원·용도를 싣는 판단은 이 전제 위에 서 있다 —
**나중에 외주 업체로 바꾸면 이 절을 다시 본다**(그때는 위탁 고지가 붙는다).

남는 의무는 §28의 관리·감독이고, 이 기능에서 그건 실무적으로 두 가지다:
번호가 바뀌면 시크릿을 즉시 갱신할 것(옛 번호로 계속 나간다), 담당자가 바뀌면 마찬가지.

## 5. 데이터 구조(모델)

```typescript
/** 문자 종류. 순서가 곧 하루 안에서 나가는 순서다. */
type CleaningSmsKind = "digest" | "update";

/**
 * 발송 상태. `reservation_sms`의 어휘를 빌리되 `no_phone`·`manual`은 없다 —
 * 수신자가 예약이 아니라 시크릿 하나라, '번호가 없다'는 예약별 사건이 아니라 서버 설정 문제다.
 */
type CleaningSmsStatus =
  | "sending"     // 선점만 하고 발송 중
  | "sent"        // 발송됨
  | "failed"      // 벤더가 거절. **자동 재시도하지 않는다** (§7 참조)
  | "expired"     // 창을 놓쳐 문자로는 안 보냄. Mattermost에는 올라갔다
  | "superseded"; // 사람이 재발송하려고 물러나게 함

/** 문자 한 통이 '그때 말한' 스케줄. 다음 틱의 diff 기준선이 된다. */
interface ScheduleSnapshot {
  entries: SnapshotEntry[];
}

interface SnapshotEntry {
  id: string;               // reservations.id (uuid) — diff의 키
  start: string;            // 'HH:MM' (KST)
  end: string;              // 'HH:MM' (KST)
  crossesMidnight: boolean; // end가 다음 날인가
  name: string;
  guests: number | null;
  purpose: string | null;
}

/** 청소 창 / 연달림 경고. 계산 결과이며 저장하지 않는다 — 스냅샷에서 항상 다시 나온다. */
interface CleaningWindow {
  from: Date | null;   // null = 하루 경계 없음 (예약 0건)
  to: Date | null;     // null = "이후" (마지막 구간)
  minutes: number | null;
}
// `remaining`이 시작을 '지금'으로 당기므로 "진행 중" 표시를 따로 두지 않는다 —
// `12:30–13:00 (30분)`이 `~13:00 (남은 30분)`과 같은 말을 더 짧게 한다.

interface TightGap {
  afterEnd: Date;      // 앞 예약 퇴실
  beforeStart: Date;   // 뒤 예약 입실
  minutes: number;     // 0 이상 30 미만
}

/** 스냅샷 둘을 비교한 결과. 셋 다 비면 변경 없음 = 문자를 만들지 않는다. */
interface ScheduleDiff {
  added: SnapshotEntry[];
  removed: SnapshotEntry[];
  changed: Array<{ before: SnapshotEntry; after: SnapshotEntry }>;
}
```

### 상수

| 이름 | 값 | 왜 이 값인가 |
|---|---|---|
| `DIGEST_HOUR` | `7` (KST) | 형운 결정 2026-08-09 |
| `DIGEST_GRACE_MINUTES` | 없음 — **`UPDATE_UNTIL_HOUR`까지** | 아래 §6 참조. 고정 60분이 아니다 |
| `MIN_CLEANING_MINUTES` | `30` | 전용 52.49㎡ 단일 공간 · 손님이 가구 정리·쓰레기 배출까지 하고 나가는 구조라는 가정. 형운 결정 2026-08-09 |
| `UPDATE_UNTIL_HOUR` | `22` (KST) | 이후 변경은 문자를 보내지 않는다(§6) |

### 변경 판정 규칙

`SnapshotEntry.id`를 키로 맞춘다.

| 상황 | 판정 | 비고 |
|---|---|---|
| 새 스냅샷에만 있는 id | `added` | 신규 예약 |
| 옛 스냅샷에만 있는 id | `removed` | **취소가 여기로 자연히 떨어진다** — `fetchRecent`가 `cancelled = false`만 가져와 취소된 예약은 목록에서 사라진다 |
| 양쪽에 있고 `start`·`end`가 다름 | `changed` | 연장·시각 조정 |
| 양쪽에 있고 시각은 같은데 이름·인원·용도만 다름 | **변경 아님** | 청소 계획이 안 바뀐다. 여기에 반응하면 연락처 백필 한 번에 문자가 나간다 |

## 6. 발송 시각 판정

전부 순수 함수(`cleaning/schedule.ts`)로 두어 실제 예약 없이 테스트한다.

### 다이제스트

```
due = 오늘 KST 07:00
  now < due                   → wait
  due ≤ now < 오늘 KST 22:00  → fire
  now ≥ 오늘 KST 22:00        → expired  (장부에 남기고 Mattermost 경고, 문자는 안 보냄)
```

**유예를 60분이 아니라 22:00까지로 둔다.** 손님 문자는 유예가 짧은 게 맞다 —
"퇴실 15분 남았어요"가 퇴실 뒤에 도착하면 손님을 혼란스럽게 할 뿐이다. 그러나 **청소
안내는 늦어도 쓸모가 있다** — 10시에 받아도 남은 청소 창은 그대로 유효하고(지난 창은 §3이 잘라낸다).

고정 60분이면 두 곳이 깨졌다:

1. **§7의 재발송 절차가 죽는다.** 사람이 10시에 `superseded`로 내려도 다음 틱은 이미
   `expired` 판정이라 문자를 보내지 않고 경고만 한 번 더 남긴다.
2. **함수가 07:00~08:01 죽어 있으면 그날 하루가 통째로 침묵한다.** 다이제스트가 만료되고,
   변경 안내는 '다이제스트가 `sent`일 때만' 열리므로 그 게이트도 영영 안 열린다.

### 변경 안내

| 조건 | 동작 |
|---|---|
| 그날 다이제스트가 아직 `sent`가 아님 | **아무것도 안 한다.** 비교할 기준선이 없다 — 07:00 이전 변경은 다이제스트가 최신 상태로 담으므로 따로 알릴 것이 없다 |
| 다이제스트 `sent` 이후 ~ 22:00 이전 | diff가 비지 않으면 **문자 + Mattermost** |
| 22:00 이후 | 문자는 **안 보낸다.** `expired` 행으로 장부에 남기고 **Mattermost에만** 올린다 |

22:00 이후를 `expired` 행으로 남기는 것이 중요하다. 행에 스냅샷을 같이 저장하므로 기준선이
갱신되고, 같은 변경을 다음 틱이 또 감지하는 무한 루프가 끊긴다. 조용히 넘기면 매 틱 같은 diff가
다시 나온다.

## 7. 데이터 저장 구조

```
public.cleaning_sms
  id            bigint identity PK
  date          date        ← KST 달력 날짜. 이 문자가 '어느 날'을 말하는가
  kind          text        ← 'digest' | 'update'
  status        text        ← 위 CleaningSmsStatus
  to_phone      text        ← 실제로 보낸 번호(정규화된 숫자만)
  body          text        ← 실제로 보낸 본문. 템플릿은 바뀌므로 '그때 뭘 보냈나'는 여기에만 남는다
  group_id      text        ← SOLAPI groupId
  error         text
  snapshot      jsonb       ← ScheduleSnapshot. 다음 diff의 기준선
  fingerprint   text        ← snapshot의 안정 해시. update 중복 선점용
  created_at    timestamptz default now()
  sent_at       timestamptz
```

### 중복 선점

`reservation_sms`와 같은 방식이다 — **발송 전에 `sending` 행을 먼저 넣어 자리를 잡고**, 유니크
인덱스가 겹친 두 호출 중 하나만 통과시킨다. `automate`는 anon key로 누구나 부를 수 있어 두 틱이
겹칠 수 있고, '보내기 전에 이미 보냈나 확인'은 두 호출이 나란히 통과한다.

```sql
-- 하루 한 통
create unique index cleaning_sms_digest_once
  on public.cleaning_sms (date)
  where kind = 'digest' and status <> 'superseded';

-- 같은 변경은 한 번만. 하루 안에 여러 번 바뀔 수 있으므로 지문으로 가른다
create unique index cleaning_sms_update_once
  on public.cleaning_sms (date, fingerprint)
  where kind = 'update' and status <> 'superseded';
```

**`failed`를 인덱스 밖에 두지 않는다** — 여기가 `reservation_sms`와 다른 유일한 지점이다.
그쪽은 손님 안내가 반드시 나가야 해서 실패를 재시도 가능하게 열어뒀지만, 여기서는 실패해도
같은 본문이 이미 Mattermost에 올라가 정보가 유실되지 않는다. 재시도를 열면 벤더 장애나 잔액
소진처럼 **다음 틱에도 똑같이 실패하는 사유**에서 1분마다 실패 행과 경고가 쌓여 채널을 못 쓰게
된다(`reservation_sms`의 `no_phone` 주석이 지적한 것과 같은 함정). 도배가 유실보다 나쁘다.

사람이 다시 보내려면 기존 행을 물러나게 하고 다음 틱을 기다린다:

```sql
update cleaning_sms set status = 'superseded'
 where date = '2026-08-09' and kind = 'digest' and status <> 'superseded';
```

이 절차는 **22:00 전에만 통한다.** 그 뒤에는 §6이 `expired`로 판정해 다음 틱이 문자를 보내지 않는다
— 그 시각에 오늘 청소 안내를 보내는 것이 이미 의미가 없어서다. 정 필요하면 사람이 Mattermost에 남은
본문을 복사해 직접 보낸다.

### 기준선(baseline) 조회

그 날짜의 `status in ('sent','expired')` 행 중 `created_at` 최신 것의 `snapshot`.
`failed`·`sending`은 기준선이 되지 못한다 — 담당자가 못 받은 내용을 '이미 안다'고 치면
그 변경이 영영 안 알려진다.

### 스냅샷 지문

`fingerprint`는 `entries`를 `id` 오름차순으로 정렬한 뒤 직렬화한 문자열의 SHA-256 hex다.
정렬을 고정하지 않으면 같은 스케줄이 배열 순서만 달라도 다른 지문이 되어 같은 변경이 두 번 나간다.

> **알려진 한계**: 스케줄이 A→B→A→B로 되돌아갔다 다시 바뀌면 두 번째 B가 첫 B와 같은 지문이라
> 선점에 막혀 문자가 안 나간다. 되돌림이 하루 안에 두 번 일어나야 성립하는 경우라 받아들인다.
> 실제로 겪으면 지문에 시퀀스를 섞는 방향으로 고친다.

## 8. 기술 구현

### 모듈 구조

```
supabase/functions/control/cleaning/
  windows.ts        예약 목록 → 청소 창 · 연달림 경고        (순수 · DB/네트워크 없음)
  templates.ts      다이제스트·변경 안내 문구 정본            (순수)
  diff.ts           스냅샷 비교 → ScheduleDiff · 지문 계산    (순수)
  schedule.ts       07:00 판정 · 22:00 창 판정                (순수)
  dispatch.ts       선점 → 발송 → 기록 → 알림 · 기준선 조회
  notify.ts         Mattermost 게시 (본문 그대로 + 결과 한 줄)
  sweep.ts          틱 진입점. 위를 이어 붙인다
```

순수 함수 넷을 따로 두는 이유는 **실제 예약 없이 전부 테스트하기 위해서다.** 이 레포는 라이브 DB에
테스트 예약을 만들면 기기 자동화가 같이 도는 구조라(2026-08-08 사고), 시각·문구 검증이 순수 함수
안에서 끝나야 한다.

### 틱에 얹는 방식

`handlers/automation.ts`의 `automate()` 안, `sweepSms` **바로 뒤**에 같은 형태로 붙인다.

```typescript
let cleaningResult = { digest: 0, update: 0, expired: 0, failed: 0 };
try {
  cleaningResult = await sweepCleaning(sb, reservations, now);
} catch (e) {
  console.error("청소 안내 스윕 실패 — 앞의 결과는 유지한다", e);
}
```

- **같은 `reservations` 배열을 재사용한다.** 따로 조회하면 기기 자동화·손님 문자·청소 안내가
  서로 다른 예약 목록을 보는 순간이 생긴다(`store.ts` 주석의 이유 그대로).
- **try/catch로 격리한다.** 여기서 예외가 새면 그 뒤의 Mattermost flush가 통째로 안 돈다.
- `prepFired`/`shutdownFired` 스킵 조건에 걸지 않는다 — 그건 기기 상태 캐시 문제라 문자와 무관하다.
- 반환값에 `cleaning` 키를 더한다(틱 응답으로 눈으로 확인할 수 있게).

### sweep.ts 흐름

```
sweepCleaning(sb, reservations, now)
  ├─ loadConfig() 없으면 → 콘솔만 남기고 종료 (장부에 안 적는다)
  ├─ CLEANING_SMS_TO 없거나 normalizePhone 실패 → 콘솔만 남기고 종료
  ├─ today = kstDay(now) · todays = 오늘 대상 예약 (§3)
  ├─ snapshot = buildSnapshot(todays)
  ├─ digest 판정
  │    wait     → 아무것도 안 함
  │    fire     → 그날 digest 행이 없으면 dispatch('digest', snapshot)
  │    expired  → 그날 digest 행이 없으면 markExpired('digest', snapshot)
  └─ digest가 sent인 경우에만
       baseline = 최신 sent/expired 행의 snapshot
       diff = compare(baseline, snapshot)
       diff가 비었으면 종료
       now < 22:00 → dispatch('update', snapshot)
       now ≥ 22:00 → markExpired('update', snapshot)   ← Mattermost에는 올린다
```

### dispatch.ts 순서 (기존 `sms/dispatch.ts`와 동일)

**선점 → 발송 → 기록 → 알림.** 선점을 발송 뒤로 옮기면 겹친 두 호출이 같은 문자를 두 번 보낸다.
발송 성공 뒤 기록 도중 함수가 죽으면 행이 `sending`에 남아 다음 시도를 막는다 — **안전한 쪽으로
죽는다**(문자는 이미 나갔으므로, 막히는 것이 두 번 가는 것보다 낫다).

### notify.ts

| 사건 | Mattermost에 올리는 것 |
|---|---|
| 발송 성공 | 문자 본문 그대로 + `· 문자 발송 완료` 한 줄 |
| 발송 실패 | `청소 안내 문자 실패` 경고 + 벤더 사유 원문 + **본문 그대로**(형운이 직접 보낼 수 있게) |
| `expired` (07:00 창 놓침) | `청소 안내 미발송` 경고 + 사유 + 본문 |
| `expired` (22:00 이후 변경) | `심야 변경 — 문자는 보내지 않았습니다` + 본문 |

`sms/notify.ts`와 같은 규율: **어떤 예외도 밖으로 던지지 않는다.** 알림이 실패했다고 이미 나간
문자가 장부에 안 적히면 안 된다.

## 9. 환경 변수 (시크릿)

| 키 | 값 | 없으면 |
|---|---|---|
| `CLEANING_SMS_TO` | 청소 담당자 휴대폰 번호 | 조용히 건너뛰고 콘솔에만 남긴다 |
| `SOLAPI_API_KEY` · `SOLAPI_API_SECRET` · `SOLAPI_SENDER` | 기존 값 재사용 | 같음 |
| `MATTERMOST_SMS_WEBHOOK_URL` 또는 `MATTERMOST_WEBHOOK_URL` | 기존 값 재사용 | 알림만 건너뛴다 |

**번호는 코드·문서·커밋 어디에도 적지 않는다.** 내부 인력이라도 남의 개인 연락처이고,
이 레포는 ThinQ PAT·service_role 키·웹훅 URL과 같은 급으로 다룬다.

미설정 시 조용히 건너뛰는 것은 `sweepSms`와 같은 판단이다 — 설정 누락은 예약의 문제가 아니라
서버의 문제라 날짜별 장부에 실패로 쌓을 사건이 아니다.

## 10. 비용

LMS(90바이트 초과) 45원/건. 다이제스트 1통 + 변경 안내 0~3통 = **하루 45~180원**.
Mattermost는 무료라 형운이 같은 내용을 받는 데 추가 비용이 없다.

## 11. 검증

### 순수 함수 테스트 (`deno test --allow-env`)

| 파일 | 무엇을 고정하나 |
|---|---|
| `windows.test.ts` | 30분 경계(29·30·31분) · 첫/마지막 구간 · 예약 0건 · **자정 넘김 예약**(22:00~02:00이 다음 날 창을 만드는지) · 어제에서 넘어온 예약이 첫 구간 시작을 미는지 · 겹친 예약을 0분으로 보는지 · **`now` 클램핑**(지난 창이 빠지는지 · 진행 중인 창이 잘리는지 · **지나간 긴 창이 연달림 경고로 둔갑하지 않는지**) |
| `schedule.test.ts` | 다이제스트 06:59 wait / 07:00 fire / 15:00 fire(늦어도 보낸다) / 21:59 fire / 22:00 expired · 변경 안내 21:59 발송 / 22:00 억제 · **KST 00:00~09:00 구간에서 날짜가 밀리지 않는지** |
| `diff.test.ts` | added·removed·changed 각각 · 이름/인원/용도만 바뀐 경우 변경 아님 · 지문이 배열 순서에 흔들리지 않는지 · 빈 diff |
| `templates.test.ts` | 두 문구 · `purpose`/`guests`가 빈 경우 그 조각만 빠지는지 · 연락처가 본문에 없는지 · 예약 0건 문구 · `내일 HH:MM 이후` 표기 |

### 사람이 확인하는 것

- 시크릿에 **형운 번호**를 먼저 넣고 하루 돌려 07:00 다이제스트를 실제로 받는다
- 그 상태에서 어드민으로 당일 예약 시간을 바꿔 변경 안내가 오는지 본다
  (**새 예약을 만들지 않는다** — 기존 예약의 시간을 고치는 `admin_set_time` 경로로 확인한다)
- Mattermost에 같은 본문이 올라오는지
- 확인 후 시크릿을 담당자 번호로 바꾼다

### 라이브 DB에 테스트 예약을 만들지 않는다

**같은 예약 행이 기기 자동화의 입력이기도 하다.** 2026-08-08에 문자만 보려고 만든 예약이
입실 준비 창 안에 들어가, 손님이 이용 중이던 시간에 냉난방이 26도 냉방으로·조명이 프리셋으로
재설정됐다(`control-setup.md` J절). 시각·문구·창 계산은 전부 위 순수 함수 테스트로 본다.

## 파일(페이지) 구성

| 파일 | 경로 | 설명 |
|---|---|---|
| `20260809000000_cleaning_sms.sql` | `supabase/migrations/` | **신규** — `cleaning_sms` 테이블 · RLS · 유니크 인덱스 2개 |
| `windows.ts` | `supabase/functions/control/cleaning/` | **신규** — 청소 창 계산 (순수) |
| `windows.test.ts` | 〃 | **신규** |
| `templates.ts` | 〃 | **신규** — 문구 정본 (순수) |
| `templates.test.ts` | 〃 | **신규** |
| `diff.ts` | 〃 | **신규** — 스냅샷 비교·지문 (순수) |
| `diff.test.ts` | 〃 | **신규** |
| `schedule.ts` | 〃 | **신규** — 발송 시각 판정 (순수) |
| `schedule.test.ts` | 〃 | **신규** |
| `dispatch.ts` | 〃 | **신규** — 선점→발송→기록→알림 · 기준선 조회 |
| `notify.ts` | 〃 | **신규** — Mattermost 게시 |
| `sweep.ts` | 〃 | **신규** — 틱 진입점 |
| `automation.ts` | `supabase/functions/control/handlers/` | **수정** — `sweepCleaning` 호출 + 반환값에 `cleaning` 키 |
| `store.ts` | `supabase/functions/control/automation/` | **수정** — `fetchRecent`의 select와 `Reservation`에 `guests`·`purpose` 추가. 이 둘은 문구에만 쓰이지만 **같은 조회에 얹어야** 기기·손님문자·청소안내가 같은 예약 목록을 본다 |
| `control-setup.md` | `06-applications/` | **수정** — K절 신설(시크릿·배포·확인 체크리스트) · "막혔을 때" 표에 행 추가 |
| `README.md` | 루트 | **수정** — "운영 시스템" 표에 청소 안내 문자 1행 |

모든 신규 `.ts`는 **200줄 미만**을 지킨다(레포 규칙). 넘으면 책임을 더 쪼갠다.

## 12. 의존성

- `automation/windows.ts` — `targetTime` · `kstDay` · `endTime`. **새로 만들지 않고 반드시 이걸 쓴다**
- `automation/store.ts` `fetchRecent` — 대상 예약 배열. 조회를 새로 하지 않는다
- `sms/solapi.ts` — `loadConfig` · `normalizePhone` · `send`
- 선행 조건 없음. 이 스펙만으로 독립 구현·배포 가능하다

## 13. 관련 스펙 변경

없음(이 레포의 첫 스펙 문서다). 기존 코드 중 **수정**하는 것은 둘뿐이다 —
`handlers/automation.ts`(스윕 호출)와 `automation/store.ts`(조회 컬럼 2개 추가).
`sms/**`는 **읽기만 한다**(`solapi.ts`의 `loadConfig`·`normalizePhone`·`send` 재사용).

## 14. 변경 이력

| 날짜 | 변경 내용 |
|---|---|
| 2026-08-09 | 최초 작성 (인터뷰: `docs/plan/.interview/2026-08-09-cleaning-digest-sms.md`) |
| 2026-08-09 | 청소 담당자가 내부 인력임을 확인 — §4의 `[확인 필요]`(개인정보 처리위탁 고지) 해소 |
| 2026-08-09 | 구현 반영 — `CleaningWindow.ongoing` 제거(창을 당기고 나면 `from–to`로 충분), `automation/store.ts`가 수정 대상에 추가됨(`guests`·`purpose`) |
| 2026-08-09 | 셀프리뷰 — 다이제스트 유예를 60분에서 22:00까지로 늘리고(§6), `now` 이후 남은 창만 싣는 규칙을 추가(§3). 고정 60분이면 §7 재발송 절차가 죽고, 함수가 한 시간 죽은 날은 하루가 통째로 침묵했다 |
