/**
 * SpaceCloud 예약완료/취소완료 메일(office@spacecloud.kr) -> Supabase RPC 자동 반영.
 * 설치/설정: README.md 참고. 이 파일은 script.google.com 프로젝트에 그대로 붙여넣는다.
 */

var SUPABASE_URL = 'https://sewqusncgznypjigmfde.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNld3F1c25jZ3pueXBqaWdtZmRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2NzM3OTAsImV4cCI6MjEwMTI0OTc5MH0.cMoaJUulz7m56aWQ8neQm013c75dGbCIuzEd8MS2vnI';

var ADMIN_URL = 'https://typelounge.vercel.app/admin';
var SPACE_NAME = 'TYPE LOUNGE';

var PROCESSED_LABEL = 'spacecloud-processed';
var ERROR_LABEL = 'spacecloud-error';
var GMAIL_QUERY = 'from:office@spacecloud.kr subject:("예약 완료" OR "취소 완료") -label:' + PROCESSED_LABEL + ' -label:' + ERROR_LABEL;

function processSpaceCloudReservations() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // 다른 실행(수동/트리거)이 이미 돌고 있으면 중복 처리 방지를 위해 종료
  var password = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!password) throw new Error('Script Property "ADMIN_PASSWORD"가 설정되지 않았습니다. README 참고.');

  var processedLabel = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
  var errorLabel = GmailApp.getUserLabelByName(ERROR_LABEL) || GmailApp.createLabel(ERROR_LABEL);

  var threads = GmailApp.search(GMAIL_QUERY, 0, 20);

  threads.forEach(function (thread) {
    var hadError = false;

    thread.getMessages().forEach(function (message) {
      try {
        if (message.getSubject().indexOf('취소') !== -1) {
          cancelReservation(parseCancellationEmail(message), password);
        } else {
          submitReservation(parseReservationEmail(message), password);
        }
      } catch (err) {
        hadError = true;
        MailApp.sendEmail(
          Session.getActiveUser().getEmail(),
          '[예약 자동등록 실패] ' + message.getSubject(),
          '메시지 날짜: ' + message.getDate() + '\n오류: ' + err.message
        );
        notifyMattermost(buildErrorMessage(message, err));
      }
    });

    thread.addLabel(hadError ? errorLabel : processedLabel);
  });

  lock.releaseLock();
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

  return {
    p_source: '스클',
    p_booking_no: bookingNo ? bookingNo[1] : null,
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

function submitReservation(reservation, password) {
  if (reservation.p_booking_no && bookingNoExists(reservation.p_booking_no, password)) return; // 이미 등록된 예약번호 → 중복 등록 방지
  var payload = Object.assign({ p_password: password }, reservation);
  callRpc('admin_add_reservation', payload);
  notifyMattermost(buildReservationMessage(reservation));
}

function bookingNoExists(bookingNo, password) {
  var reservations = callRpc('admin_list_reservations', { p_password: password });
  return reservations.some(function (r) { return r.booking_no === bookingNo; });
}

/**
 * 취소 메일 반영. 멱등이어야 한다 — 같은 메일이 다시 처리되는 경우(라벨 수동 해제, 수동 재실행,
 * 취소 메일이 예약 메일보다 먼저 처리되는 순서 역전)가 실제로 발생했다(2026-08-03 10:53 알림).
 * "이미 취소됨"은 실패가 아니라 목표 상태 도달이므로 조용히 종료한다. 예약 자체가 없을 때만 에러.
 */
function cancelReservation(cancellation, password) {
  var reservations = callRpc('admin_list_reservations', { p_password: password });

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

  var match = candidates.filter(function (r) { return !r.cancelled; })[0];
  if (!match) return; // 이미 취소됨 — 재처리이므로 RPC·알림 없이 종료

  callRpc('admin_set_cancelled', { p_password: password, p_id: match.id, p_value: true });
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
 * (실패 시 스레드가 spacecloud-error로 라벨링되어 정상 등록된 예약이 재처리 대상에서 빠지는 것을 방지)
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
  ]) + '\n\n수동 확인이 필요합니다. 원인 해결 후 Gmail에서 `' + ERROR_LABEL + '` 라벨을 떼면 다음 실행 때 재시도됩니다.' +
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

/** 1회 실행: 15분마다 자동으로 processSpaceCloudReservations를 돌리는 트리거 설치 */
function createTrigger() {
  ScriptApp.newTrigger('processSpaceCloudReservations').timeBased().everyMinutes(15).create();
}
