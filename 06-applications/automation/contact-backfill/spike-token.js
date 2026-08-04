/**
 * 스파이크: "사람 개입 0으로 파트너 토큰이 나오는가?"
 *
 * 이 한 가지 답이 연락처 백필 자동화의 범위를 정한다.
 *  - 나온다  -> 무인 백필 가능 (LaunchAgent + 시간당 스윕)
 *  - 안 나온다 -> 반자동으로 축소 (토큰만 하루 1회 사람이, 나머지는 자동)
 *
 * 실행:
 *   node spike-token.js --setup    처음 한 번. 브라우저가 열리면 네이버로 로그인한다
 *   node spike-token.js            무인 검증. 토큰을 지우고 사람 없이 복구되는지 본다
 *
 * ⚠️ 그냥 돌리면 "이미 토큰 있음"으로 통과해 아무것도 검증하지 못한다. 그래서 기본 모드는
 * localStorage의 토큰을 **일부러 지우고** 시작한다. 네이버 쿠키는 그대로 두므로 24시간 뒤
 * 실제로 벌어지는 상황과 같다(스클은 인증 쿠키를 쓰지 않는다 — 2026-08-03 실측).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PARTNER,
  PROFILE_DIR,
  openContext,
  readToken,
  acquireToken,
  trackNavigation,
  waitForToken
} from './session.js';

const SHOT_DIR = path.join(os.homedir(), '.typelounge', 'spike');
const SETUP_TIMEOUT_MS = 5 * 60 * 1000;   // 사람이 로그인하는 시간
const VERIFY_TIMEOUT_MS = 60 * 1000;      // 무인 리다이렉트가 끝나야 하는 시간

function log(msg) {
  console.log(`[spike] ${msg}`);
}

function remaining(exp) {
  return `${((exp - Date.now()) / 3600000).toFixed(1)}시간 남음`;
}

/** 실패 지점을 눈으로 봐야 원인이 잡힌다. 레포 밖에 저장한다 — 화면에 예약자 정보가 있을 수 있다. */
async function capture(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

/** 프로필에 네이버 세션을 심는다. 사람이 로그인할 때까지 기다리는 것 말고는 하는 일이 없다. */
async function setup(page) {
  log(`프로필: ${PROFILE_DIR}`);
  await page.goto(`${PARTNER}/auth/login`, { waitUntil: 'domcontentloaded' });

  console.log('\n브라우저에서 "네이버로 호스트 로그인"을 눌러 로그인하세요. 최대 5분 기다립니다.\n');

  const token = await waitForToken(page, SETUP_TIMEOUT_MS);
  if (!token) throw new Error('5분 안에 로그인이 끝나지 않았습니다.');

  log(`토큰 확보 — ${remaining(token.exp)}`);
  log('프로필에 네이버 세션이 저장됐습니다. 이제 "node spike-token.js"로 무인 검증을 하세요.');
}

/** 토큰을 지운 뒤 사람 없이 되찾아지는지 본다. 이게 스파이크의 본체다. */
async function verify(page) {
  await page.goto(`${PARTNER}/reservation`, { waitUntil: 'domcontentloaded' });

  const before = await readToken(page);
  if (!before.valid) {
    log(`시작 시점에 토큰이 이미 없습니다 (${before.reason}) — 그대로 무인 획득을 시도합니다.`);
  } else {
    log(`기존 토큰 발견 (${remaining(before.exp)}) — 만료 상황을 만들기 위해 지웁니다.`);
    await page.evaluate(() => localStorage.removeItem('spacecloud__userInfo'));
  }

  const visited = [];
  trackNavigation(page, (url) => visited.push(url));

  const started = Date.now();
  try {
    const token = await acquireToken(page, { timeoutMs: VERIFY_TIMEOUT_MS, log });
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    console.log('\n=== 결과: 무인 획득 성공 ===');
    console.log(`소요 ${secs}초 · 토큰 ${remaining(token.exp)}`);
    console.log(`거친 경로 ${visited.length}개:`);
    visited.forEach((u) => console.log(`  - ${u.split('?')[0]}`));
    console.log('\n판정: 사람 개입 없이 토큰이 나옵니다. 무인 백필로 진행 가능합니다.');
    return true;
  } catch (err) {
    const shot = await capture(page, 'verify-failed');

    console.log('\n=== 결과: 무인 획득 실패 ===');
    console.log(`사유: ${err.message}`);
    console.log(`멈춘 위치: ${page.url()}`);
    console.log(`거친 경로 ${visited.length}개:`);
    visited.forEach((u) => console.log(`  - ${u.split('?')[0]}`));
    console.log(`화면: ${shot}`);
    console.log(
      '\n판정: 무인 획득이 막혔습니다. 화면을 보고 무엇이 끼었는지 확인하세요\n' +
        '  (네이버 동의 화면 / 기기 인증 / 캡차 / 세션 만료).\n' +
        '  세션 만료라면 --setup 을 다시 돌리면 되고, 그 외라면 반자동으로 범위를 줄여야 합니다.'
    );
    return false;
  }
}

async function main() {
  const isSetup = process.argv.includes('--setup');
  const context = await openContext({ headless: false });
  const page = context.pages()[0] || (await context.newPage());

  try {
    const ok = isSetup ? (await setup(page), true) : await verify(page);
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error(`\n[spike] 중단: ${err.message}`);
    await capture(page, 'crashed');
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

main();
