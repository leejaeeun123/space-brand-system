/**
 * SpaceCloud 파트너 운영지표 -> Supabase 수집기.
 *
 * 파트너 콘솔의 "통계" 화면(partner.spacecloud.kr/report/statistics)이 그리는 값을
 * 그 화면이 쓰는 API에서 그대로 받아 `sc_daily_stats` / `sc_daily_keywords`에 넣는다.
 * 화면은 캔버스라 긁을 수 없지만, 긁을 필요가 없다 — 아래 두 엔드포인트가 원천이다.
 *
 * 실행: partner.spacecloud.kr 탭의 콘솔에 이 파일을 통째로 붙여넣은 뒤
 *   await scStats.run('<admin.html 비밀번호>')                 // 최근 14일 재수집 (기본)
 *   await scStats.run('<비밀번호>', { all: true })              // 전체 기간 백필
 *   await scStats.run('<비밀번호>', { dryRun: true })           // 미리보기 (DB 변경 없음)
 *   await scStats.fetchWindow('2026-08-01', '2026-08-14')      // 수집만 (비밀번호 불필요)
 *
 * 형제 스크립트 `spacecloud-api-sync.js`(예약 동기화)와 같은 자리에서 같은 방식으로 돈다 —
 * 토큰 수명·재로그인 사정이 동일하므로 인증 부분은 의도적으로 같은 모양을 유지한다.
 *
 * 한 파일로 유지하는 이유: 브라우저 콘솔에 붙여넣어 쓰는 스크립트라 import가 불가능하다.
 */

var scStats = (function () {
  'use strict';

  var API = 'https://api.spacecloud.kr';
  var SUPABASE_URL = 'https://sewqusncgznypjigmfde.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNld3F1c25jZ3pueXBqaWdtZmRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2NzM3OTAsImV4cCI6MjEwMTI0OTc5MH0.cMoaJUulz7m56aWQ8neQm013c75dGbCIuzEd8MS2vnI';

  // 타입라운지 공간 ID. 콘솔 상단 공간 선택 <option value="80401">에서 온다 —
  // 공간이 늘면 그 값으로 바꾸거나 opts.spaceId로 넘긴다.
  var SPACE_ID = 80401;

  // 기본 재수집 창. 스클 지표는 실시간이 아니고 나중에 보정되므로(콘솔 유의사항) 매번
  // 최근 구간을 통째로 다시 받아 덮어쓴다. 그래서 며칠 걸러도 저절로 메워진다.
  var WINDOW_DAYS = 14;

  // --- 인증 ----------------------------------------------------------------
  // spacecloud-api-sync.js와 동일하다. 토큰은 발급 후 24시간이면 죽고 갱신 수단이 없다.

  /** localStorage의 파트너 토큰을 읽는다. 없거나 만료면 valid=false. */
  function readToken() {
    var raw = localStorage.getItem('spacecloud__userInfo');
    if (!raw) return { valid: false, reason: '로그아웃 상태' };

    var token = JSON.parse(raw).accessToken;
    // 로그아웃 시 앱이 localStorage에 {} 를 써놓는다. token이 undefined인 채 .split을 불러
    // TypeError로 터지면 아래 ensureSession의 안내에 닿지 못한다.
    if (!token) return { valid: false, reason: 'accessToken 없음' };
    var exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000;
    if (Date.now() >= exp) return { valid: false, reason: '토큰 만료', exp: exp };

    return { valid: true, token: token, exp: exp };
  }

  /**
   * 세션을 보장한다. 리프레시 토큰·인증 쿠키가 모두 없어 재로그인이 유일한 길이다.
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

  // --- 날짜 ----------------------------------------------------------------

  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }

  /** Date -> 'YYYY-MM-DD' (UTC 필드로만 계산해 로컬 타임존 영향을 받지 않는다) */
  function iso(d) {
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /** 'YYYY-MM-DD' -> '20260814' (API 파라미터 형식) */
  function compact(s) { return s.replace(/-/g, ''); }

  function addDays(isoDate, n) {
    var d = new Date(isoDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
  }

  /**
   * 한국시간 기준 오늘. 스클 지표는 한국 서비스이고 D-1로 확정되므로 기준 시각도 한국시간이어야
   * 한다 — 브라우저가 어느 타임존이든 같은 답을 내도록 UTC+9로 직접 옮긴다.
   */
  function kstToday() {
    return iso(new Date(Date.now() + 9 * 3600 * 1000));
  }

  /** 수집 상한. 오늘(D-0)은 API가 에러 대신 말끔한 0을 주므로 절대 포함하지 않는다. */
  function lastAvailableDate() { return addDays(kstToday(), -1); }

  /**
   * 차트 라벨('07.22')에는 연도가 없다. 요청 시작일에서 출발해 월이 줄어들면 해를 넘긴다 —
   * 리스팅이 12월을 넘기면 이 보정이 없을 때 모든 날짜가 한 해 과거로 박힌다.
   */
  function labelsToDates(labels, fromDate) {
    var year = Number(fromDate.slice(0, 4));
    var prev = Number(fromDate.slice(5, 7));
    return labels.map(function (l) {
      var mm = l.slice(0, 2), dd = l.slice(3, 5);
      var m = Number(mm);
      if (m < prev) year += 1;
      prev = m;
      return year + '-' + mm + '-' + dd;
    });
  }

  // --- 수집 ----------------------------------------------------------------

  /** 차트 한 시리즈에서 특정 dataset의 값 배열을 꺼낸다. 없으면 전부 0으로 본다. */
  function series(stat, key, label) {
    var s = stat[key];
    if (!s || !s.datasets) return null;
    var ds = s.datasets.filter(function (d) { return d.label === label; })[0];
    return ds ? ds.data : null;
  }

  function at(arr, i) { return arr && arr[i] != null ? Number(arr[i]) : 0; }

  /**
   * [from, to] 구간을 모아 DB에 넣을 행으로 만든다.
   *
   * 차트는 한 번에 받고, 지표는 **하루씩** 받는다 — 지표를 기간으로 받으면 다시 쪼갤 수 없고,
   * 하루씩 받으면 우리가 언제든 합칠 수 있기 때문이다(마이그레이션 설계 1).
   *
   * 값이 아예 없는 날은 차트 라벨에서 빠진다("집계된 데이터가 없을 시 표시되지 않습니다").
   * 그래서 **구간 첫 라벨보다 앞선 날짜는 쓰지 않는다** — 리스팅 이전이라 0이 아니라 '없음'이다.
   * 반대로 첫 라벨 이후에 빠진 날은 진짜 0으로 본다.
   */
  async function fetchWindow(from, to, spaceId) {
    var session = await ensureSession();
    spaceId = spaceId || SPACE_ID;

    var q = 'start_date=' + compact(from) + '&end_date=' + compact(to) +
            '&space_id=' + spaceId + '&type=day';
    var stat = await get('/partner/statistics?' + q, session.token);

    var labels = (stat.impression_data && stat.impression_data.labels) || [];
    if (!labels.length) return { stats: [], keywords: [], note: '구간에 집계된 데이터가 없습니다' };

    var dates = labelsToDates(labels, from);
    var pos = {};
    dates.forEach(function (d, i) { pos[d] = i; });

    // 실제 수집 구간은 **차트 라벨의 양 끝으로 좁힌다.**
    //
    //  · 앞쪽 — 첫 라벨보다 앞선 날은 리스팅 이전이라 0이 아니라 '없음'이다.
    //  · 뒤쪽 — 지표(host_stat_indicators)가 차트보다 하루 먼저 채워진다. 2026-08-16 실측:
    //    08-15는 지표에 게스트 8명이 있는데 차트 라벨엔 아직 없다(`08-13~15` 요청이
    //    `["08.13","08.14"]`만 준다). 이때 차트 값을 0으로 채워 쓰면 **도달·클릭이 실제로는
    //    있었는데 0으로 박힌다** — D-0 방어가 막으려던 바로 그 '아직 없음을 0으로 오해'가
    //    뒷문으로 들어오는 셈이다. 그래서 차트가 아직 모르는 날은 아예 쓰지 않는다.
    //
    // 덮어쓰기 재수집이라 손해가 없다 — 다음 실행에서 차트가 따라잡으면 그때 제대로 들어간다.
    var last = dates[dates.length - 1];
    var start = dates[0] > from ? dates[0] : from;
    var end = last < to ? last : to;

    var col = {
      impT: series(stat, 'impression_data', '전체'),
      impN: series(stat, 'impression_data', '일반'),
      impA: series(stat, 'impression_data', '광고'),
      impE: series(stat, 'impression_data', '기타'),
      // ⚠️ 클릭수의 API 키는 click_data 가 아니라 show_data 다.
      clkT: series(stat, 'show_data', '전체'),
      clkN: series(stat, 'show_data', '일반'),
      clkA: series(stat, 'show_data', '광고'),
      clkE: series(stat, 'show_data', '기타'),
      rcC: series(stat, 'reservation_count_data', '예약확정'),
      rcU: series(stat, 'reservation_count_data', '이용완료'),
      rcX: series(stat, 'reservation_count_data', '예약취소'),
      raC: series(stat, 'reservation_amount_data', '예약확정'),
      raU: series(stat, 'reservation_amount_data', '이용완료'),
      raX: series(stat, 'reservation_amount_data', '예약취소'),
      calT: series(stat, 'call_count_data', '전체'),
      calS: series(stat, 'call_count_data', '성공'),
      calF: series(stat, 'call_count_data', '실패')
    };

    var stats = [], keywords = [];

    for (var d = start; d <= end; d = addDays(d, 1)) {
      var ind = await get(
        '/partner/host_stat_indicators?start_date=' + compact(d) + '&end_date=' + compact(d) +
        '&space_id=' + spaceId + '&type=day', session.token);

      var i = pos[d] != null ? pos[d] : -1;   // -1 이면 차트에 없는 날 = 0

      stats.push({
        space_id: spaceId,
        stat_date: d,

        usedc_guest_count:             Number(ind.usedc_guest_count || 0),
        reservation_usedc_count:       Number(ind.reservation_usedc_count || 0),
        reservation_confirm_count:     Number(ind.reservation_confirm_count || 0),
        reservation_amount:            Number(ind.reservation_amount || 0),
        reservation_total_count:       Number(ind.reservation_total_count || 0),
        re_reservation_count:          Number(ind.re_reservation_count || 0),
        qa_count:                      Number(ind.qa_count || 0),
        qa_answer_complete_count:      Number(ind.qa_answer_complete_count || 0),
        review_count:                  Number(ind.review_count || 0),
        review_answer_complete_count:  Number(ind.review_answer_complete_count || 0),
        zzim_count:                    Number(ind.zzim_count || 0),
        review_score_sum:              Number(ind.review_score_sum || 0),
        reservation_approve_count:     Number(ind.reservation_approve_count || 0),
        reservation_cancel_count:      Number(ind.reservation_cancel_count || 0),
        reservation_guest_cancel_count: Number(ind.reservation_guest_cancel_count || 0),
        reservation_host_cancel_count:  Number(ind.reservation_host_cancel_count || 0),

        impression_total:  at(col.impT, i),
        impression_normal: at(col.impN, i),
        impression_ad:     at(col.impA, i),
        impression_etc:    at(col.impE, i),
        click_total:       at(col.clkT, i),
        click_normal:      at(col.clkN, i),
        click_ad:          at(col.clkA, i),
        click_etc:         at(col.clkE, i),

        rsv_confirm_count:  at(col.rcC, i),
        rsv_usedc_count:    at(col.rcU, i),
        rsv_cancel_count:   at(col.rcX, i),
        rsv_confirm_amount: at(col.raC, i),
        rsv_usedc_amount:   at(col.raU, i),
        rsv_cancel_amount:  at(col.raX, i),

        call_total:   at(col.calT, i),
        call_success: at(col.calS, i),
        call_fail:    at(col.calF, i)
      });

      // ⚠️ 이 값은 건수가 아니라 그 날 유입에서 차지한 **비율(%)** 이고, 상위 5개에서 잘린다.
      // 하루 합이 100이 안 되는 날이 정상이다(실측 73~101). 자세한 함정은 테이블 주석에 있다.
      var sw = ind.search_word_data;
      if (sw && sw.labels && sw.labels.length) {
        var shares = (sw.datasets && sw.datasets[0] && sw.datasets[0].data) || [];
        sw.labels.forEach(function (kw, k) {
          keywords.push({
            space_id: spaceId, stat_date: d,
            rank: k + 1, keyword: String(kw), share_pct: Number(shares[k] || 0)
          });
        });
      }

      await new Promise(function (r) { setTimeout(r, 120); });   // 파트너 API 배려
    }

    return {
      stats: stats, keywords: keywords, from: start, to: end,
      // 차트가 아직 못 따라온 꼬리. 러너가 "왜 어제가 안 들어왔나"에 답할 수 있게 실어 보낸다.
      pending: end < to ? (addDays(end, 1) + ' ~ ' + to) : null
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
   * 수집 -> 반영. 받은 날짜를 통째로 갈아끼우므로 몇 번을 돌려도 안전하다.
   *
   * opts: { all, from, to, days, spaceId, dryRun }
   *   all   전체 기간 백필(2026-01-01부터 요청 — API가 실제 시작일까지만 준다)
   *   days  최근 N일 (기본 14)
   */
  async function run(password, opts) {
    opts = opts || {};
    var dryRun = !!opts.dryRun;
    // 미리보기는 DB를 건드리지 않으므로 비밀번호를 요구하지 않는다 — 수집만 확인하려고
    // 비밀번호를 꺼내오게 만들면, 안 꺼내도 되는 상황에서 자꾸 꺼내는 습관이 생긴다.
    if (!password && !dryRun) throw new Error('admin.html 비밀번호가 필요합니다.');

    var to = opts.to || lastAvailableDate();
    var from = opts.from ||
      (opts.all ? '2026-01-01' : addDays(to, -((opts.days || WINDOW_DAYS) - 1)));

    if (from > to) throw new Error('시작일이 종료일보다 늦습니다: ' + from + ' ~ ' + to);

    var got = await fetchWindow(from, to, opts.spaceId);
    if (!got.stats.length) {
      // 사유를 그대로 실어 보낸다 — 러너가 이걸 화면에 띄워야 "0일"이 성공으로 안 읽힌다.
      var why = got.note || ('요청 구간 ' + from + ' ~ ' + to + '에 집계된 데이터가 없습니다');
      console.warn('수집할 데이터가 없습니다: ' + why);
      return { written: 0, stats: [], keywords: [], note: why };
    }

    if (dryRun) {
      console.log('[미리보기] ' + got.from + ' ~ ' + got.to + ' · ' +
        got.stats.length + '일 · 키워드 ' + got.keywords.length + '행 (DB 변경 없음)');
      console.table(got.stats.map(function (r) {
        return {
          날짜: r.stat_date, 도달: r.impression_total, 클릭: r.click_total,
          확정건: r.reservation_confirm_count, 확정액: r.reservation_amount,
          이용완료: r.reservation_usedc_count, 게스트: r.usedc_guest_count
        };
      }));
      return got;
    }

    var written = await rpc('admin_upsert_sc_daily', {
      p_password: password, p_stats: got.stats, p_keywords: got.keywords
    });

    console.log('반영 완료: ' + got.from + ' ~ ' + got.to + ' · ' + written + '일 · 키워드 ' +
      got.keywords.length + '행');
    return { written: written, stats: got.stats, keywords: got.keywords, pending: got.pending };
  }

  return {
    readToken: readToken, ensureSession: ensureSession,
    fetchWindow: fetchWindow, run: run,
    lastAvailableDate: lastAvailableDate, labelsToDates: labelsToDates
  };
})();
