/**
 * SpaceCloud 파트너 API -> Supabase 동기화 (API 우선 경로).
 *
 * Gmail 파서(spacecloud-gmail-sync.gs)가 못 가져오던 연락처·이메일·사용목적·인원을
 * 파트너 API에서 직접 받아 admin.html이 쓰는 Supabase RPC로 반영한다.
 * Gmail 쪽은 백업으로 남는다 — 상세는 README.md "이중 경로" 참고.
 *
 * 실행: partner.spacecloud.kr 탭의 콘솔에 이 파일을 통째로 붙여넣은 뒤
 *   await scSync.run('<admin.html 비밀번호>')          // 실제 반영
 *   await scSync.run('<비밀번호>', { dryRun: true })   // 미리보기 (DB 변경 없음)
 *   await scSync.fetchAll()                            // 수집만 (비밀번호 불필요)
 *
 * 한 파일로 유지하는 이유: 브라우저 콘솔에 붙여넣어 쓰는 스크립트라 import가 불가능하다.
 */

var scSync = (function () {
  'use strict';

  var API = 'https://api.spacecloud.kr';
  var SUPABASE_URL = 'https://sewqusncgznypjigmfde.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNld3F1c25jZ3pueXBqaWdtZmRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2NzM3OTAsImV4cCI6MjEwMTI0OTc5MH0.cMoaJUulz7m56aWQ8neQm013c75dGbCIuzEd8MS2vnI';

  var SOURCE = '스클';
  var CANCELLED = 'RCCMP';   // 취소완료. 이 상태면 API가 예약자명을 마스킹하고 연락처·이메일을 안 준다.

  // --- 인증 ----------------------------------------------------------------

  /** localStorage의 파트너 토큰을 읽는다. 없거나 만료면 valid=false. */
  function readToken() {
    var raw = localStorage.getItem('spacecloud__userInfo');
    if (!raw) return { valid: false, reason: '로그아웃 상태' };

    var token = JSON.parse(raw).accessToken;
    var exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000;
    if (Date.now() >= exp) return { valid: false, reason: '토큰 만료', exp: exp };

    return { valid: true, token: token, exp: exp };
  }

  /**
   * 세션을 보장한다. 토큰은 발급 후 24시간이면 죽고 갱신 수단이 없다
   * (리프레시 토큰·인증 쿠키 모두 없음 — 2026-08-03 확인). 재로그인이 유일한 길이다.
   * 네이버 OAuth는 비밀번호 없이 리다이렉트만으로 새 토큰을 받으므로 이쪽을 쓴다.
   */
  async function ensureSession() {
    var t = readToken();
    if (t.valid) return t;

    if (!/\/auth\/login/.test(location.pathname)) {
      throw new Error(t.reason + '. https://partner.spacecloud.kr/auth/login 으로 이동한 뒤 다시 실행하세요.');
    }

    var naver = Array.prototype.slice.call(document.querySelectorAll('a'))
      .filter(function (a) { return /네이버/.test(a.textContent); })[0];
    if (!naver) throw new Error('네이버 로그인 버튼을 찾지 못했습니다.');

    naver.click();
    throw new Error('네이버 재로그인을 시작했습니다. 리다이렉트가 끝나면 다시 실행하세요.');
  }

  function get(path, token) {
    return fetch(API + path, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    }).then(function (r) {
      if (!r.ok) throw new Error('파트너 API 실패 (' + r.status + '): ' + path);
      return r.json();
    });
  }

  // --- 수집 ----------------------------------------------------------------

  /** 목록 + 각 건의 상세를 모두 받아온다. 상세에만 연락처·이메일·인원·요청사항이 있다. */
  async function fetchAll() {
    var session = await ensureSession();
    var page = 1, ids = [];

    for (;;) {
      var res = await get('/partner/reservations?page=' + page, session.token);
      ids = ids.concat(res.reservations.map(function (r) { return r.id; }));
      if (!res.page || page >= res.page.pages) break;
      page += 1;
    }

    var details = [];
    for (var i = 0; i < ids.length; i += 1) {
      details.push(await get('/partner/reservations/' + ids[i], session.token));
    }
    return details;
  }

  // --- 변환 ----------------------------------------------------------------

  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }

  /** "20260806" -> "2026-08-06" */
  function toIsoDate(ymd) {
    if (!ymd) return null;
    return ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8);
  }

  /**
   * API -> admin_add_reservation 파라미터.
   *
   * ⚠️ end_hour는 "포함(inclusive)"이다. API가 16-18이면 실제 이용은 16시~19시 3시간이고
   * 호스트 페이지에도 "16~19 시, 3 시간"으로 표시된다. 2026-08-03 예약 9건 전수 대조로 확인
   * (13-20 / 64,000원 = 8시간 x 8,000원처럼 단가가 정확히 떨어지는 것도 같은 결론).
   * 그래서 종료 시각은 반드시 +1 해야 한다 — 안 하면 모든 예약이 1시간씩 짧게 들어간다.
   */
  function toPayload(d, password) {
    var u = d.user_info || {};
    var options = (d.options || []).map(function (o) { return o.name || o.title || String(o); });

    return {
      p_password: password,
      p_source: SOURCE,
      p_booking_no: String(d.id),
      p_applied: toIsoDate(d.created_at),
      p_date: toIsoDate(d.start_ymd),
      p_start: pad2(d.start_hour) + ':00',
      p_end: pad2(Number(d.end_hour) + 1) + ':00',
      p_guests: d.member_count || null,
      p_purpose: d.purpose || null,
      p_option: options.length ? options.join(', ') : null,
      p_request: d.note || null,
      p_name: u.name || null,
      p_phone: u.phone || null,
      p_email: u.email || null,
      p_amount: d.paid_price != null ? Number(d.paid_price) : null,
      p_payment: (d.payment && (d.payment.pay_method || d.payment.pg_code)) || null,
      p_memo: (d.space && d.space.space_name) || null
    };
  }

  // --- 반영 ----------------------------------------------------------------

  function rpc(name, payload) {
    return fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('Supabase RPC 실패 (' + r.status + '): ' + t); });
      return r.json();
    });
  }

  /**
   * 수집 -> 대조 -> 반영. 예약번호로 중복을 거르므로 몇 번을 돌려도 안전하다.
   * dryRun이면 계획만 만들고 DB는 건드리지 않는다.
   */
  async function run(password, options) {
    if (!password) throw new Error('admin.html 비밀번호가 필요합니다.');
    var dryRun = !!(options && options.dryRun);

    var details = await fetchAll();
    var existing = await rpc('admin_list_reservations', { p_password: password });

    var byBookingNo = {};
    existing.forEach(function (r) { if (r.booking_no) byBookingNo[String(r.booking_no)] = r; });

    var plan = { added: [], cancelled: [], skipped: [], maskedAdds: [] };

    for (var i = 0; i < details.length; i += 1) {
      var d = details[i];
      var no = String(d.id);
      var isCancelled = d.RSV_STAT_CD === CANCELLED;
      var known = byBookingNo[no];

      if (!known) {
        var payload = toPayload(d, password);
        if (!payload.p_name) { plan.skipped.push({ no: no, why: '예약자명 없음' }); continue; }

        if (!dryRun) {
          var inserted = await rpc('admin_add_reservation', payload);
          // 취소건은 API가 이미 마스킹된 데이터만 준다. 그래도 기록은 남겨야 이용 이력이 비지 않는다.
          if (isCancelled && inserted && inserted.id) {
            await rpc('admin_set_cancelled', { p_password: password, p_id: inserted.id, p_value: true });
          }
        }
        (isCancelled ? plan.maskedAdds : plan.added).push({ no: no, name: payload.p_name, date: payload.p_date });
        continue;
      }

      if (isCancelled && !known.cancelled) {
        if (!dryRun) await rpc('admin_set_cancelled', { p_password: password, p_id: known.id, p_value: true });
        plan.cancelled.push({ no: no, name: known.name, date: known.date });
        continue;
      }

      plan.skipped.push({ no: no, why: '이미 반영됨' });
    }

    console.log(
      (dryRun ? '[미리보기] ' : '') +
      '신규 ' + plan.added.length + '건 · 취소반영 ' + plan.cancelled.length + '건 · ' +
      '마스킹된 취소건 신규 ' + plan.maskedAdds.length + '건 · 건너뜀 ' + plan.skipped.length + '건'
    );
    if (plan.maskedAdds.length) {
      console.warn('아래 취소건은 API가 예약자명을 마스킹해 연락처·이메일이 비어 있습니다. ' +
        'Gmail 취소 메일에는 실명이 오므로 필요하면 admin.html에서 보완하세요:', plan.maskedAdds);
    }
    return plan;
  }

  /** "01040360713" -> "010-4036-0713". DB의 기존 표기가 하이픈 형식이라 맞춘다. */
  function hyphenPhone(p) {
    if (!p) return null;
    var digits = String(p).replace(/[^0-9]/g, '');
    if (digits.length !== 11) return p;
    return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
  }

  /**
   * 이미 등록된 예약의 "빈" 연락처·이메일만 채운다 (백필).
   *
   * Gmail 경로로 들어온 건은 이 두 필드가 비어 있다 — 알림 메일에 안 실려오기 때문.
   * admin_fill_contact가 값이 있는 칸은 건드리지 않으므로 몇 번을 돌려도 안전하다.
   * 취소건(RCCMP)은 API가 연락처를 안 주므로 자동으로 건너뛴다.
   */
  async function fillContacts(password, options) {
    if (!password) throw new Error('admin.html 비밀번호가 필요합니다.');
    var dryRun = !!(options && options.dryRun);

    var details = await fetchAll();
    var filled = [], skipped = [];

    for (var i = 0; i < details.length; i += 1) {
      var d = details[i];
      var u = d.user_info || {};
      if (!u.phone && !u.email) { skipped.push({ no: String(d.id), why: d.RSV_STAT_CD === CANCELLED ? '취소건 — API가 마스킹' : '연락처 없음' }); continue; }

      if (!dryRun) {
        try {
          await rpc('admin_fill_contact', {
            p_password: password, p_booking_no: String(d.id),
            p_phone: hyphenPhone(u.phone), p_email: u.email || null
          });
        } catch (err) {
          skipped.push({ no: String(d.id), why: err.message });  // DB에 없는 예약 등
          continue;
        }
      }
      filled.push({ no: String(d.id), name: u.name });
    }

    console.log((dryRun ? '[미리보기] ' : '') + '연락처 대상 ' + filled.length + '건 · 건너뜀 ' + skipped.length + '건');
    if (skipped.length) console.warn('건너뛴 건:', skipped);
    return { filled: filled, skipped: skipped };
  }

  return {
    readToken: readToken, ensureSession: ensureSession, fetchAll: fetchAll,
    toPayload: toPayload, run: run, fillContacts: fillContacts
  };
})();
