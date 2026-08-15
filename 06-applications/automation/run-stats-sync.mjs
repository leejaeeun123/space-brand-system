#!/usr/bin/env node
/**
 * 스클 운영지표 수집을 한 줄로 돌린다 — 콘솔에 붙여넣지 않고.
 *
 *   node run-stats-sync.mjs --dry-run          # 미리보기 (비밀번호 불필요)
 *   node run-stats-sync.mjs                    # 최근 14일 재수집
 *   node run-stats-sync.mjs --all              # 전체 기간 백필
 *   node run-stats-sync.mjs --days 30
 *
 * 비밀번호는 `TL_ADMIN_PASSWORD` 환경변수로 주거나, 없으면 화면에 안 보이게 물어본다.
 *
 * ── 왜 브라우저를 거치는가 ───────────────────────────────────────────────────
 *
 * 파트너 토큰은 브라우저 localStorage에만 있고 24시간이면 죽는다. 리프레시 토큰도 인증
 * 쿠키도 없어서 재로그인이 유일한 갱신 수단인데, 그 재로그인이 네이버 OAuth라 **사람만
 * 뚫는다**(contact-backfill/README.md의 2026-08-04 실측). 그래서 이 스크립트는 서버에서
 * 혼자 돌지 못하고, 사람이 이미 로그인해 둔 Aside 브라우저의 세션을 빌린다.
 *
 * 대신 손이 가는 부분을 여기까지 줄였다 — 탭을 찾고, 수집기를 주입하고, 결과를 받아온다.
 * 사람이 하는 일은 **토큰이 죽었을 때 한 번 로그인하는 것**뿐이다.
 *
 * ⚠️ 무인(cron/launchd) 실행을 이 위에 얹지 말 것. 토큰이 죽은 날 조용히 실패하고,
 *    지표는 D-1이라 아무도 그날 안에 눈치채지 못한다. 놓친 날은 다음 실행이 알아서
 *    메우므로(최근 구간을 통째로 다시 받는다) 며칠 걸러 돌려도 데이터는 안 빈다.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARTNER = 'https://partner.spacecloud.kr';
const STATS_PAGE = PARTNER + '/report/statistics';

// --- 인자 ------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const opts = { dryRun: has('--dry-run'), all: has('--all') };
if (val('--days')) opts.days = Number(val('--days'));
if (val('--from')) opts.from = val('--from');
if (val('--to')) opts.to = val('--to');

// --- 비밀번호 ---------------------------------------------------------------

/**
 * 입력이 화면에 안 찍히게 물어본다. 셸 히스토리에도 ps에도 남지 않는다.
 *
 * ⚠️ **음소거는 `question()`을 부른 "뒤"에 켠다.** terminal 모드의 readline은 출력을
 *    `_writeToOutput`으로만 그리는데, 이걸 먼저 막아버리면 **물어보는 문구까지 사라져서**
 *    화면엔 커서만 깜빡이고 사용자는 멈춘 줄 안다. 또 빈 문자열로 `question('')`을
 *    부르면 readline이 줄을 다시 그리면서 미리 출력해둔 문구를 지운다 —
 *    2026-08-15 실제로 그렇게 보였다(프롬프트 없이 커서만).
 *    그래서 문구는 `question()`에 넘기고, 그게 나간 뒤에 음소거를 켠다.
 */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('비밀번호가 필요합니다. TL_ADMIN_PASSWORD 환경변수로 주세요.'));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };

    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;   // 프롬프트는 이미 나갔다 — 여기부터 타이핑만 숨는다
  });
}

async function resolvePassword() {
  if (opts.dryRun) return '';                      // 미리보기는 DB를 안 건드린다
  if (process.env.TL_ADMIN_PASSWORD) return process.env.TL_ADMIN_PASSWORD;
  return askHidden('admin.html 비밀번호: ');
}

// --- 실행 ------------------------------------------------------------------

const password = await resolvePassword();
const source = readFileSync(path.join(HERE, 'spacecloud-stats-sync.js'), 'utf8');

// 수집기 원문·비밀번호·옵션을 JSON으로 실어 보낸다. 문자열 이어붙이기로 만들면
// 비밀번호에 따옴표나 백틱이 있을 때 조용히 깨진다.
//
// ⚠️ **반드시 한 줄이어야 한다.** `aside repl`은 stdin을 대화형 REPL로 받아 **줄 단위로
//    평가**하므로, 여러 줄로 보내면 첫 줄만 실행되고 나머지가 `Unexpected token ';'`으로
//    터진다(2026-08-15 실측). 인자로 넘기면 여러 줄이 되지만 그러면 **비밀번호가 `ps`에
//    노출된다** — 그래서 stdin + 한 줄을 택했다. 여기에 줄바꿈이나 `//` 주석을 넣지 말 것.
const payload = [
  'const tabs = await listBrowserTabs();',
  `const found = tabs.find((t) => t.url && t.url.startsWith(${JSON.stringify(PARTNER)}));`,
  `const page = found ? await attachBrowserTab(found.targetId) : await openTab(${JSON.stringify(STATS_PAGE)});`,
  'const result = await page.evaluate(async ([src, pw, o]) => {' +
    ' eval(src);' +
    ' const t = scStats.readToken();' +
    ' if (!t.valid) { return { ok: false, needLogin: true, reason: t.reason }; }' +
    ' try {' +
    '   const r = await scStats.run(pw, o);' +
    '   const st = r.stats || [];' +
    '   return { ok: true, written: r.written == null ? null : r.written, days: st.length,' +
    '            keywords: (r.keywords || []).length, note: r.note || null,' +
    '            pending: r.pending || null,' +
    '            asked: o, first: st.length ? st[0].stat_date : null,' +
    '            last: st.length ? st[st.length - 1].stat_date : null };' +
    ' } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }' +
    `}, [${JSON.stringify(source)}, ${JSON.stringify(password)}, ${JSON.stringify(opts)}]);`,
  "console.log('__RESULT__' + JSON.stringify(result));"
].join(' ');

const child = spawn('aside', ['repl'], { stdio: ['pipe', 'pipe', 'inherit'] });
// 개행이 없으면 REPL이 "아직 안 끝난 줄"로 보고 평가하지 않는다 — 조용히 아무 일도
// 일어나지 않으므로 빠뜨리면 원인 찾기가 오래 걸린다(2026-08-15 실측).
child.stdin.end(payload + '\n');

let out = '';
child.stdout.on('data', (b) => { out += b.toString(); });

child.on('close', () => {
  const m = out.match(/__RESULT__(\{.*\})/);
  if (!m) {
    console.error('수집기 응답을 찾지 못했습니다. Aside 출력:\n' + out);
    process.exit(1);
  }
  const r = JSON.parse(m[1]);

  if (r.needLogin) {
    console.error(
      `파트너 토큰이 없습니다 (${r.reason}).\n` +
      `${PARTNER}/auth/login 에서 네이버로 로그인한 뒤 다시 실행하세요.\n` +
      '토큰은 24시간이면 죽고 자동 갱신 경로가 없습니다 — 이 한 단계만 사람이 합니다.'
    );
    process.exit(2);
  }
  if (!r.ok) {
    console.error('수집 실패: ' + r.error);
    process.exit(1);
  }

  // 0일을 "DB 반영 0일"로 알리면 성공처럼 읽힌다 — 실제로는 아무 일도 안 일어났고,
  // 이유(구간에 집계가 없음)가 화면에 안 나온다. 매일 도는 경로라 여기서 뭉개면
  // "돌고는 있는데 데이터가 안 는다"를 한참 못 알아챈다.
  if (r.days === 0) {
    console.warn(
      '수집한 날짜가 0일입니다 — DB는 그대로입니다.\n' +
      (r.note ? `  이유: ${r.note}\n` : '') +
      '  스클 집계는 D-1이 원칙이지만 하루 더 늦어지는 날이 있습니다.\n' +
      '  기본 실행(--days 14)은 최근 구간을 통째로 다시 받으므로, 나중에 다시 돌리면 저절로 메워집니다.'
    );
    process.exit(0);
  }

  console.log(
    (opts.dryRun ? '[미리보기] ' : '') +
    `${r.first} ~ ${r.last} · ${r.days}일 · 키워드 ${r.keywords}행` +
    (opts.dryRun ? ' (DB 변경 없음)' : ` · DB 반영 ${r.written}일`)
  );

  // 꼬리를 밝힌다 — 안 그러면 "어제 걸 돌렸는데 어제가 없다"로 보인다.
  if (r.pending) {
    console.log(`  (${r.pending}은 아직 스클 차트 집계 전이라 건너뜀 — 다음 실행에서 들어옵니다)`);
  }
});
