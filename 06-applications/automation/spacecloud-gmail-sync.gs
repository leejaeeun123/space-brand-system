/**
 * SpaceCloud 예약완료/취소완료 메일(office@spacecloud.kr) -> Supabase RPC 자동 반영.
 * 설치/설정: README.md 참고. 이 파일은 script.google.com 프로젝트에 그대로 붙여넣는다.
 */

var SUPABASE_URL = 'https://sewqusncgznypjigmfde.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNld3F1c25jZ3pueXBqaWdtZmRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2NzM3OTAsImV4cCI6MjEwMTI0OTc5MH0.cMoaJUulz7m56aWQ8neQm013c75dGbCIuzEd8MS2vnI';

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
    p_purpose: null,
    p_option: extractField(html, '예약옵션') || null,
    p_request: extractField(html, '요청사항') || null,
    p_name: name,
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
}

function bookingNoExists(bookingNo, password) {
  var reservations = callRpc('admin_list_reservations', { p_password: password });
  return reservations.some(function (r) { return r.booking_no === bookingNo; });
}

function cancelReservation(cancellation, password) {
  var reservations = callRpc('admin_list_reservations', { p_password: password });
  var match = reservations.filter(function (r) {
    return !r.cancelled && r.date === cancellation.date &&
      String(r.start_time).slice(0, 5) === cancellation.start &&
      String(r.end_time).slice(0, 5) === cancellation.end;
  })[0];

  if (!match) {
    throw new Error(
      '취소 대상 예약을 찾지 못했습니다: ' + cancellation.date + ' ' + cancellation.start + '-' + cancellation.end +
      ' (' + cancellation.name + (cancellation.reason ? ', 사유: ' + cancellation.reason : '') + ')'
    );
  }

  callRpc('admin_set_cancelled', { p_password: password, p_id: match.id, p_value: true });
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

/** 1회 실행: 15분마다 자동으로 processSpaceCloudReservations를 돌리는 트리거 설치 */
function createTrigger() {
  ScriptApp.newTrigger('processSpaceCloudReservations').timeBased().everyMinutes(15).create();
}
