/**
 * SpaceCloud 예약완료/취소완료 메일(office@spacecloud.kr) -> Supabase RPC 자동 반영.
 * 설치/설정: README.md 참고. 이 파일은 script.google.com 프로젝트에 그대로 붙여넣는다.
 *
 * ⚠ 처리 단위는 **메시지**다. 스레드가 아니다.
 * 스페이스클라우드는 모든 예약 메일의 제목이 똑같아서 Gmail이 한 스레드로 묶는다.
 * 예전엔 스레드에 라벨을 붙이고 `-label:`로 걸렀는데, 라벨이 붙은 뒤 같은 스레드로 들어온
 * 메일은 쿼리에서 통째로 사라져 **예약이 조용히 누락**됐다(2026-08-03 예약 스레드는
 * 09:12~14:04 5건이 한 덩어리였다 — 15분 트리거가 그걸 한 번에 담는 건 불가능하다).
 * 지금은 처리한 messageId를 스크립트 속성에 남겨 거른다. 라벨은 사람이 보는 표시일 뿐
 * 재처리 여부를 결정하지 않는다.
 */

var SUPABASE_URL = 'https://sewqusncgznypjigmfde.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNld3F1c25jZ3pueXBqaWdtZmRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2NzM3OTAsImV4cCI6MjEwMTI0OTc5MH0.cMoaJUulz7m56aWQ8neQm013c75dGbCIuzEd8MS2vnI';

var ADMIN_URL = 'https://typelounge.vercel.app/admin';
var SPACE_NAME = 'TYPE LOUNGE';
var SENDER = 'office@spacecloud.kr';

var PROCESSED_LABEL = 'spacecloud-processed';
var ERROR_LABEL = 'spacecloud-error';

/** 라벨로 거르지 않으므로 창을 날짜로 좁힌다. 트리거가 15분마다 도니 7일이면 충분히 넉넉하다. */
var LOOKBACK = 'newer_than:7d';
var GMAIL_QUERY = 'from:' + SENDER + ' subject:("예약 완료" OR "취소 완료") ' + LOOKBACK;

/** 처리 기록 저장소. 값은 아래 STATE_* 규약을 따르는 정수 하나다. */
var PROCESSED_PROP = 'PROCESSED_MESSAGES';
var STATE_DONE = 0;       // 반영 완료 — 다시 건드리지 않는다
var STATE_GIVEN_UP = -1;  // MAX_ATTEMPTS 소진 — 사람이 봐야 한다
// 1 이상 = 지금까지 실패한 횟수 (다음 실행에서 재시도)

/**
 * 실패는 3번까지 조용히 재시도한다. 일시적인 RPC 오류는 대개 여기서 낫고,
 * 진짜 문제만 45분 뒤 한 번 알림이 나간다 — 15분마다 같은 실패를 알리면 알림이 무시된다.
 */
var MAX_ATTEMPTS = 3;

/**
 * 스크립트 속성 1개는 9KB가 상한이다. 엔트리 하나가 `"<id>":0,` 약 21바이트라 300건이면
 * 6KB 안쪽으로 안전하고, 7일 창(하루 수 건)을 크게 웃돈다. 넘치면 오래된 것부터 버린다.
 * 버려진 메일이 아직 창 안에 있으면 다시 처리되는데, 등록은 예약번호로 걸러지고
 * 취소는 멱등이라 해롭지 않다.
 */
var MAX_ENTRIES = 300;

/**
 * 일 1회 감사(dailyAudit)의 신선도 임계값. STALE_DAYS 이상 매칭 메일이 0건이면 백업 경로가
 * 조용히 죽은 것으로 보고 알린다. 3일인 이유: 2026-08-09 자동화가 3일 침묵한 실측이 기준이고,
 * LOOKBACK(7일) 이하여야 쿼리 창 안에서 실제로 측정된다 — 더 크게 잡으면 메일이 창 밖으로 밀려 신선도를 못 잰다.
 * HEALTH_ALERT_PROP에 마지막 경보 시각을 남겨 스팸을 막는다.
 */
var STALE_DAYS = 3;
var HEALTH_ALERT_PROP = 'LAST_HEALTH_ALERT_AT';

function processSpaceCloudReservations() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // 다른 실행(수동/트리거)이 이미 돌고 있으면 중복 처리 방지를 위해 종료

  var store = null;
  try {
    var password = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
    if (!password) throw new Error('Script Property "ADMIN_PASSWORD"가 설정되지 않았습니다. README 참고.');

    store = loadStore();
    var touched = {};   // threadId -> { thread: GmailThread, failed: boolean }

    collectMessages().forEach(function (entry) {
      var id = entry.message.getId();
      var state = store.hasOwnProperty(id) ? store[id] : null;
      if (state === STATE_DONE || state === STATE_GIVEN_UP) return; // 이미 끝난 건

      try {
        if (entry.isCancellation) {
          cancelReservation(parseCancellationEmail(entry.message), password);
        } else {
          submitReservation(parseReservationEmail(entry.message), password);
        }
        store[id] = STATE_DONE;
        markThread(touched, entry.thread, false);
      } catch (err) {
        var attempts = (state || 0) + 1;
        if (attempts < MAX_ATTEMPTS) {
          store[id] = attempts;  // 조용히 재시도 — 다음 실행(15분 뒤)에 다시 온다
          console.warn('처리 실패 ' + attempts + '/' + MAX_ATTEMPTS + ' (' + entry.message.getSubject() + '): ' + err.message);
          return;
        }
        store[id] = STATE_GIVEN_UP;
        markThread(touched, entry.thread, true);
        MailApp.sendEmail(
          Session.getActiveUser().getEmail(),
          '[예약 자동등록 실패] ' + entry.message.getSubject(),
          '메시지 날짜: ' + entry.message.getDate() + '\n' +
          MAX_ATTEMPTS + '회 시도 후 포기했습니다.\n오류: ' + err.message
        );
        notifyMattermost(buildErrorMessage(entry.message, err));
      }
    });

    applyLabels(touched);
  } finally {
    // 도중에 무엇이 터지든 여기까지 한 일은 남긴다 — 안 남기면 다음 실행이 같은 걸 또 반영한다.
    if (store) saveStore(store);
    lock.releaseLock();
  }
}

/**
 * 창 안의 대상 메시지를 **시간 오름차순**으로 모은다.
 *
 * 정렬이 핵심이다. 취소 메일이 그 예약의 등록 메일보다 먼저 처리되면 취소할 대상을 못 찾아
 * 실패한다(2026-08-03 10:53 "취소 대상 예약을 찾지 못했습니다"가 그 사례다).
 * 도착 순서대로 처리하면 예약이 항상 먼저 들어간다.
 *
 * Gmail 검색은 **스레드** 단위로 맞춘다 — 스레드 안에 조건과 무관한 메시지가 섞여 있을 수
 * 있으므로 발신자와 제목을 메시지 단위로 한 번 더 확인한다.
 */
function collectMessages() {
  var entries = [];
  GmailApp.search(GMAIL_QUERY, 0, 50).forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (message.getFrom().indexOf(SENDER) === -1) return;
      var subject = message.getSubject() || '';
      var isCancellation = subject.indexOf('취소 완료') !== -1;
      if (!isCancellation && subject.indexOf('예약 완료') === -1) return;
      entries.push({ thread: thread, message: message, isCancellation: isCancellation });
    });
  });
  entries.sort(function (a, b) { return a.message.getDate() - b.message.getDate(); });
  return entries;
}

function markThread(touched, thread, failed) {
  var id = thread.getId();
  if (!touched[id]) touched[id] = { thread: thread, failed: false };
  if (failed) touched[id].failed = true;
}

/**
 * 라벨은 **사람이 Gmail에서 훑어보기 위한 표시**다. 재처리 여부는 messageId 기록이 정한다.
 * 그래서 라벨을 손으로 떼도 다시 처리되지 않는다 — 재처리가 필요하면 reprocessMessages()를 쓴다.
 */
function applyLabels(touched) {
  var ids = Object.keys(touched);
  if (!ids.length) return;

  var processedLabel = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
  var errorLabel = GmailApp.getUserLabelByName(ERROR_LABEL) || GmailApp.createLabel(ERROR_LABEL);

  ids.forEach(function (id) {
    var t = touched[id];
    t.thread.addLabel(t.failed ? errorLabel : processedLabel);
  });
}

function loadStore() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_PROP);
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (err) {
    // 비우고 시작하면 창 안의 메일이 다시 처리된다. 등록은 예약번호로, 취소는 멱등성으로
    // 걸러지므로 데이터는 안전하지만, 원인은 남겨야 한다.
    console.error('처리 기록을 읽지 못해 비우고 시작합니다: ' + err.message);
    return {};
  }
}

function saveStore(store) {
  var ids = Object.keys(store);
  // 자바스크립트 객체는 문자열 키의 삽입 순서를 지킨다. 메시지를 시간순으로 처리하므로
  // 뒤쪽이 최신이다 — 넘치면 앞(오래된 것)을 잘라낸다.
  if (ids.length > MAX_ENTRIES) ids = ids.slice(ids.length - MAX_ENTRIES);

  var pruned = {};
  ids.forEach(function (id) { pruned[id] = store[id]; });
  PropertiesService.getScriptProperties().setProperty(PROCESSED_PROP, JSON.stringify(pruned));
}

function parseReservationEmail(message) {
  var html = message.getBody();
  var applied = Utilities.formatDate(message.getDate(), 'Asia/Seoul', 'yyyy-MM-dd');

  var period = parsePeriod(extractField(html, '예약내용'));

  var name = extractField(html, '예약자명');
  if (!name) throw new Error('예약자명을 찾지 못했습니다.');

  var guests = extractField(html, '예약인원').match(/\d+/);
  var amount = extractField(html, '결제금액').replace(/[^0-9]/g, '');
  var bookingNo = html.match(/reservation%2F(\d+)/) || html.match(/reservation\/(\d+)/);
  // 예약번호 실패를 예약자명 실패와 동급 에러로 올린다. 조용히 null로 넣으면 partial unique 인덱스가
  // 못 막아(where booking_no is not null) API 경로가 같은 예약을 둘째 행으로 또 등록한다 —
  // 시끄럽게 재시도·알림을 태우는 게 이 파이프라인의 다른 실패 처리와 일관된다.
  if (!bookingNo) throw new Error('예약번호(booking_no)를 찾지 못했습니다. 스클이 링크 형식을 바꿨을 수 있습니다.');

  return {
    p_source: '스클',
    p_booking_no: bookingNo[1],
    p_applied: applied,
    p_date: period.date,
    p_start: period.start,
    p_end: period.end,
    p_guests: guests ? Number(guests[0]) : null,
    p_purpose: null,  // 아래 phone/email 과 같은 이유로 메일에 없음
    p_option: extractField(html, '예약옵션') || null,
    p_request: extractField(html, '요청사항') || null,
    p_name: name,
    // 스클 "예약 완료" 메일에는 연락처·이메일·사용목적이 실려오지 않는다(2026-08-03 원문 확인:
    // 오는 필드는 예약공간·예약내용·예약인원·예약자명·결제수단·결제금액뿐. 전화번호/이메일 패턴도 원문에 0건).
    // 필요하면 스클 예약 상세 페이지에서 따로 가져와야 한다 — 파서를 고쳐도 안 나온다.
    p_phone: null,
    p_email: null,
    p_amount: amount ? Number(amount) : null,
    p_payment: extractField(html, '결제수단') || null,
    p_memo: extractField(html, '예약공간') || null
  };
}

function parseCancellationEmail(message) {
  var html = message.getBody();
  var period = parsePeriod(extractField(html, '예약내용'));

  return {
    date: period.date,
    start: period.start,
    end: period.end,
    name: extractField(html, '예약자명'),
    reason: extractField(html, '취소사유') || null
  };
}

function parsePeriod(content) {
  var m = content.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2})시\s*-\s*(\d{1,2})시/);
  if (!m) throw new Error('예약내용 형식을 해석하지 못했습니다: "' + content + '"');
  return {
    date: m[1] + '-' + m[2] + '-' + m[3],
    start: pad2(m[4]) + ':00',
    end: pad2(m[5]) + ':00'
  };
}

/**
 * 예약 목록 캐시 — 한 실행 안에서만 산다(Apps Script는 실행마다 전역을 초기화한다).
 * 메시지 단위로 처리하면서 매 건 목록을 다시 받으면 RPC 호출이 메시지 수만큼 늘어난다.
 * 등록·취소로 목록이 바뀌면 반드시 버린다 — 안 버리면 방금 넣은 예약을 못 찾는다.
 */
var reservationsCache = null;

function listReservations(password) {
  if (!reservationsCache) reservationsCache = callRpc('admin_list_reservations', { p_password: password });
  return reservationsCache;
}

function invalidateReservations() {
  reservationsCache = null;
}

function submitReservation(reservation, password) {
  if (reservation.p_booking_no && bookingNoExists(reservation.p_booking_no, password)) return; // 이미 등록된 예약번호 → 중복 등록 방지
  var payload = Object.assign({ p_password: password }, reservation);
  callRpc('admin_add_reservation', payload);
  invalidateReservations();
  notifyMattermost(buildReservationMessage(reservation));
}

function bookingNoExists(bookingNo, password) {
  return listReservations(password).some(function (r) { return r.booking_no === bookingNo; });
}

/**
 * 취소 메일 반영. 멱등이어야 한다 — 같은 메일이 다시 처리되는 경우(처리 기록 손실, 수동 재실행)가
 * 실제로 발생했다(2026-08-03 10:53 알림).
 * "이미 취소됨"은 실패가 아니라 목표 상태 도달이므로 조용히 종료한다. 예약 자체가 없을 때만 에러.
 */
function cancelReservation(cancellation, password) {
  var reservations = listReservations(password);

  // cancelled 여부와 무관하게 (날짜+시작+종료)로 먼저 찾는다.
  // 여기서 cancelled를 걸러내면 "이미 취소된 예약"과 "존재하지 않는 예약"이 구분되지 않는다.
  var candidates = reservations.filter(function (r) {
    return r.date === cancellation.date &&
      String(r.start_time).slice(0, 5) === cancellation.start &&
      String(r.end_time).slice(0, 5) === cancellation.end;
  });

  if (!candidates.length) {
    throw new Error(
      '취소 대상 예약을 찾지 못했습니다: ' + cancellation.date + ' ' + cancellation.start + '-' + cancellation.end +
      ' (' + cancellation.name + (cancellation.reason ? ', 사유: ' + cancellation.reason : '') + ')'
    );
  }

  // 재처리·재예약 겹침 방어: 같은 (날짜+시작+종료)에 행이 둘 이상 공존할 수 있다 —
  // A가 취소한 슬롯을 B(또는 같은 사람)가 재예약하면 A=cancelled, B=active가 함께 남는다.
  // 이때 A의 취소 메일이 재처리되면(처리 기록 손실 등) 이름 대조 없이 !cancelled 첫 행만 고르면
  // 무고한 B를 취소시킨다. 그래서 예약자명으로 대상을 특정한다:
  //  (1) 이미 취소된 후보 중 같은 이름이 있으면 이 취소는 이미 반영됨 → 활성 행을 건드리지 않는다.
  //  (2) 그다음 활성 후보에서 같은 이름을 찾는다.
  //  (3) 이름으로 못 좁혔는데 취소된 후보가 있으면(마스킹 등) 역시 재처리로 보고 건드리지 않는다.
  // 트레이드오프: 같은 사람이 취소→재예약→다시 취소하면 두 번째 취소가 (1)에 걸린다. 취소 메일엔
  // 예약번호가 없어 재처리와 구분할 수 없어서다 — 놓친 취소(안전)가 무고한 취소(위험)보다 낫다는 쪽을
  // 택했다. 다만 **넘어갈 때 조용히 넘어가지 않는다**: 그 모호한 경우는 정확히 판별되므로(같은 이름의
  // 취소 행과 활성 행이 공존) 그때만 Mattermost로 사람을 부른다. 단일 공간이라 한 슬롯의 활성 예약은
  // 최대 1건이므로, 취소 이력이 없을 때의 active[0] 폴백은 모호하지 않다.
  var active = candidates.filter(function (r) { return !r.cancelled; });

  var match;
  if (cancellation.name) {
    if (candidates.some(function (r) { return r.cancelled && r.name === cancellation.name; })) {
      // 같은 이름의 **활성 행까지** 함께 있으면 두 해석이 갈린다: 이미 반영된 취소의 재처리이거나,
      // 같은 사람이 재예약한 뒤 그걸 다시 취소한 것이거나. 취소 메일엔 예약번호가 없어 코드로는
      // 못 가른다. 우리는 안전한 쪽(안 건드림)을 택하지만, **그 선택을 조용히 하지는 않는다** —
      // 후자였다면 취소된 줄 아는 손님의 예약이 살아 있고, 그 시각에 냉난방·조명이 그대로 돈다.
      // 사람이 어드민에서 1분이면 확인할 수 있는 일이라 알리는 비용이 놓치는 비용보다 싸다.
      if (active.some(function (r) { return r.name === cancellation.name; })) {
        notifyMattermost(
          '⚠️ 취소 메일을 반영하지 않고 넘어갔습니다 — 같은 이름의 취소된 예약과 살아 있는 예약이 함께 있어 ' +
          '어느 쪽인지 코드가 가릴 수 없습니다.\n' +
          '· ' + cancellation.date + ' ' + cancellation.start + '-' + cancellation.end +
          ' (' + cancellation.name + ')\n' +
          '재예약을 다시 취소한 것이라면 어드민에서 직접 취소해 주세요. 그냥 재처리였다면 조치할 것이 없습니다.'
        );
      }
      return;
    }
    match = active.filter(function (r) { return r.name === cancellation.name; })[0];
    if (!match && candidates.some(function (r) { return r.cancelled; })) return;
  }
  if (!match) match = active[0];
  if (!match) return; // 활성 예약 없음 = 이미 취소됨(재처리) → RPC·알림 없이 종료

  callRpc('admin_set_cancelled', { p_password: password, p_id: match.id, p_value: true });
  invalidateReservations();
  notifyMattermost(buildCancellationMessage(cancellation, match));
}

function callRpc(name, payload) {
  var response = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code >= 300) throw new Error('Supabase RPC 실패 (' + code + '): ' + response.getContentText());
  return JSON.parse(response.getContentText());
}

function extractField(html, label) {
  var re = new RegExp('<td[^>]*>\\s*' + label + '\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>', 'i');
  var match = html.match(re);
  if (!match) return '';
  return match[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function pad2(n) {
  n = String(n);
  return n.length < 2 ? '0' + n : n;
}

/**
 * Mattermost 알림. 알림 실패가 예약 처리 결과를 오염시키면 안 되므로 어떤 예외도 밖으로 던지지 않는다.
 * (실패 시 해당 메시지가 실패로 기록되어 이미 반영된 예약이 재시도 대상이 되는 것을 방지)
 */
function notifyMattermost(text) {
  try {
    var url = PropertiesService.getScriptProperties().getProperty('MATTERMOST_WEBHOOK_URL');
    if (!url) return;

    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ text: text }),
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    if (code >= 300) console.error('Mattermost 알림 실패 (' + code + '): ' + response.getContentText());
  } catch (err) {
    console.error('Mattermost 알림 예외: ' + err.message);
  }
}

function buildReservationMessage(r) {
  var guests = r.p_guests ? ' (' + r.p_guests + '명)' : '';
  return '**새 예약** · ' + (r.p_memo || SPACE_NAME) + '\n\n' + mdTable([
    ['예약자', r.p_name + guests],
    ['일시', formatPeriod(r.p_date, r.p_start, r.p_end)],
    ['결제', joinNonEmpty([formatAmount(r.p_amount), r.p_payment], ' · ')],
    ['옵션', r.p_option],
    ['요청', r.p_request],
    ['예약번호', r.p_booking_no]
  ]) + '\n\n[어드민에서 보기](' + ADMIN_URL + ')';
}

function buildCancellationMessage(cancellation, match) {
  return '**예약 취소** · ' + ((match && match.memo) || SPACE_NAME) + '\n\n' + mdTable([
    ['예약자', cancellation.name || (match && match.name)],
    ['일시', formatPeriod(cancellation.date, cancellation.start, cancellation.end)],
    ['사유', cancellation.reason],
    ['예약번호', match && match.booking_no]
  ]) + '\n\n[어드민에서 보기](' + ADMIN_URL + ')';
}

function buildErrorMessage(message, err) {
  return '**예약 자동등록 실패** · ' + SPACE_NAME + '\n\n' + mdTable([
    ['메일 제목', message.getSubject()],
    ['메일 날짜', Utilities.formatDate(message.getDate(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')],
    ['오류', err.message]
  ]) + '\n\n' + MAX_ATTEMPTS + '회 시도 후 포기했습니다. 원인 해결 후 `reprocessMessages()`로 재시도하세요.' +
    '\n[어드민에서 보기](' + ADMIN_URL + ')';
}

/** [라벨, 값] 배열을 마크다운 표로. 값이 빈 행은 생략한다. */
function mdTable(rows) {
  var lines = ['| 항목 | 내용 |', '|---|---|'];
  rows.forEach(function (row) {
    var value = row[1];
    if (value === null || value === undefined || String(value).trim() === '') return;
    lines.push('| ' + row[0] + ' | ' + escapePipes(String(value).trim()) + ' |');
  });
  return lines.join('\n');
}

/** 값에 포함된 |·개행이 표 구조를 깨뜨리지 않도록 무해화 (요청사항 등 자유 입력 대비) */
function escapePipes(value) {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatPeriod(date, start, end) {
  if (!date) return '';
  return date + ' (' + weekdayKo(date) + ') ' + start + '–' + end;
}

function weekdayKo(date) {
  var parts = date.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
}

function formatAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return '';
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
}

function joinNonEmpty(values, separator) {
  return values.filter(function (v) { return v !== null && v !== undefined && String(v).trim() !== ''; }).join(separator);
}

/* ── 운영 도구 ─────────────────────────────────────────────────────────────── */

/**
 * 진단 전용 — 메일과 DB를 대조만 하고 **아무것도 바꾸지 않는다.**
 *
 * 라벨 방식이던 시절 누락된 예약이 있는지 확인하는 용도다. 실행 로그에 결과가 찍힌다.
 * days를 비우면 30일을 본다.
 */
function auditReservations(days) {
  var password = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!password) throw new Error('Script Property "ADMIN_PASSWORD"가 설정되지 않았습니다.');

  var query = 'from:' + SENDER + ' subject:("예약 완료" OR "취소 완료") newer_than:' + (days || 30) + 'd';
  var reservations = callRpc('admin_list_reservations', { p_password: password });
  var problems = [];
  var checked = 0;

  GmailApp.search(query, 0, 100).forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (message.getFrom().indexOf(SENDER) === -1) return;
      var subject = message.getSubject() || '';
      var isCancellation = subject.indexOf('취소 완료') !== -1;
      if (!isCancellation && subject.indexOf('예약 완료') === -1) return;

      var when = Utilities.formatDate(message.getDate(), 'Asia/Seoul', 'MM-dd HH:mm');
      checked++;
      try {
        if (isCancellation) {
          var c = parseCancellationEmail(message);
          var hit = reservations.filter(function (r) {
            return r.date === c.date &&
              String(r.start_time).slice(0, 5) === c.start &&
              String(r.end_time).slice(0, 5) === c.end;
          });
          if (!hit.length) {
            problems.push(when + ' 취소 · DB에 예약 자체가 없음: ' + c.date + ' ' + c.start + '-' + c.end + ' (' + c.name + ')');
          } else if (!hit.some(function (r) { return r.cancelled; })) {
            problems.push(when + ' 취소 · 취소 반영 안 됨: ' + c.date + ' ' + c.start + '-' + c.end + ' (' + c.name + ')');
          }
        } else {
          var v = parseReservationEmail(message);
          var found = reservations.some(function (r) {
            return v.p_booking_no
              ? r.booking_no === v.p_booking_no
              : (r.date === v.p_date && String(r.start_time).slice(0, 5) === v.p_start);
          });
          if (!found) {
            problems.push(when + ' 예약 · DB에 없음: ' + v.p_date + ' ' + v.p_start + '-' + v.p_end +
              ' (' + v.p_name + ', 예약번호 ' + v.p_booking_no + ')');
          }
        }
      } catch (err) {
        problems.push(when + ' 파싱 실패: ' + err.message);
      }
    });
  });

  console.log('메일 ' + checked + '건 대조 · DB 예약 ' + reservations.length + '건');
  if (!problems.length) console.log('불일치 없음.');
  else problems.forEach(function (p) { console.warn(p); });
  return problems;
}

/**
 * 창 안의 메일을 다시 처리한다. 실패해서 포기(STATE_GIVEN_UP)한 건을 원인 해결 후 되살리는 용도.
 *
 * 처리 기록만 지우고 다음 트리거를 기다린다 — 등록은 예약번호로, 취소는 멱등성으로 걸러지므로
 * 이미 반영된 건이 중복되지 않는다. 예약번호 추출 실패는 이제 null로 조용히 들어가지 않고
 * 에러로 죽으므로(parseReservationEmail), null 중복 등록은 이 수정 이전 행에만 해당한다 —
 * 의심되면 먼저 auditReservations()로 확인한다.
 */
function reprocessMessages() {
  PropertiesService.getScriptProperties().deleteProperty(PROCESSED_PROP);
  console.log('처리 기록을 비웠습니다. 다음 트리거(최대 15분) 또는 processSpaceCloudReservations() 수동 실행으로 재처리됩니다.');
}

/** 1회 실행: 트리거 설치 (중복 설치 방지). 15분마다 processSpaceCloudReservations, 하루 1회 dailyAudit. */
function createTrigger() {
  var handlers = { processSpaceCloudReservations: true, dailyAudit: true };
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processSpaceCloudReservations').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('dailyAudit').timeBased().everyDays(1).atHour(9).create();
}

/**
 * 일 1회 트리거로 도는 감사. 15분 처리 루프가 못 잡는 두 가지를 본다.
 *
 * (1) 신선도(checkFreshness) — Gmail 백업 경로가 쿼리 수준에서 조용히 죽는 경우.
 *     스클이 발신주소·제목을 바꾸거나 트리거가 소멸하면 매칭 메일이 0이 되는데 그 자체로는
 *     아무 알림이 없다(2026-08-09 automate 3일 침묵이 그 부류다). 건별 처리 실패는 재시도·포기가
 *     알리지만, "메일이 아예 안 온다"는 여기서만 잡힌다.
 * (2) 대조(auditReservations) — 메일과 DB의 불일치를 훑어 있으면 한 번에 요약해 알린다
 *     (여태 콘솔에만 찍히던 것을 사람에게). 정상 상태에선 불일치 0건이라 조용하다.
 *
 * 신선도를 먼저·독립적으로 돌린다. auditReservations는 ADMIN_PASSWORD가 없으면 throw하고 RPC도
 * 실패할 수 있는데, 그게 신선도 알림을 삼키면 안 된다 — 신선도는 Gmail만 있으면 판정된다.
 */
function dailyAudit() {
  checkFreshness();

  try {
    var problems = auditReservations();
    if (problems.length) {
      notifyMattermost('**예약 감사 · 불일치 ' + problems.length + '건** · ' + SPACE_NAME + '\n\n' +
        problems.slice(0, 10).map(function (p) { return '- ' + escapePipes(p); }).join('\n') +
        (problems.length > 10 ? '\n- …외 ' + (problems.length - 10) + '건' : '') +
        '\n\n[어드민에서 보기](' + ADMIN_URL + ')');
    }
  } catch (err) {
    console.error('auditReservations 실패: ' + err.message);
  }
}

/**
 * Gmail 백업 경로 신선도. STALE_DAYS 이상 매칭 메일이 0건이면 경보를 보낸다.
 * 한산한 며칠과 완전히 구분되지는 않지만(스클 메일이 아예 안 오는 상황), 알림은 STALE_DAYS
 * 주기로만 나가 스팸이 되지 않는다 — 놓친 예약 손실이 헛알림보다 비싸다.
 */
function checkFreshness() {
  var freshest = 0;
  GmailApp.search(GMAIL_QUERY, 0, 50).forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (message.getFrom().indexOf(SENDER) === -1) return;
      var subject = message.getSubject() || '';
      if (subject.indexOf('취소 완료') === -1 && subject.indexOf('예약 완료') === -1) return;
      var t = message.getDate().getTime();
      if (t > freshest) freshest = t;
    });
  });

  var ageDays = freshest ? (Date.now() - freshest) / 86400000 : Infinity;
  if (ageDays <= STALE_DAYS) return; // 최근에 매칭 메일이 왔다 → 정상

  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty(HEALTH_ALERT_PROP) || 0);
  if (Date.now() - last < STALE_DAYS * 86400000) return; // 최근에 이미 알렸다 → 스팸 방지
  props.setProperty(HEALTH_ALERT_PROP, String(Date.now()));
  notifyMattermost(buildStaleMessage(ageDays));
}

function buildStaleMessage(ageDays) {
  var howLong = ageDays === Infinity
    ? 'Gmail 검색 창(' + LOOKBACK.replace('newer_than:', '') + ') 내내'
    : Math.floor(ageDays) + '일 동안';
  return '**예약 자동수집 신선도 경보** · ' + SPACE_NAME + '\n\n' +
    '스페이스클라우드 예약/취소 메일이 ' + howLong + ' 한 건도 오지 않았습니다.\n' +
    '한산한 기간일 수 있지만, 발신 주소·제목 변경이나 트리거 정지로 백업 경로가 조용히 죽은 것일 수도 있습니다.\n' +
    '확인할 것: Gmail 검색 `' + GMAIL_QUERY + '` · Apps Script 트리거 상태 · 실행 기록.' +
    '\n[어드민에서 보기](' + ADMIN_URL + ')';
}
