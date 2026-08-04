/**
 * 스페이스클라우드 파트너 토큰 확보 — 전용 크롬 프로필 사용.
 *
 * 토큰은 브라우저 localStorage에만 있고 24시간이면 죽는다. 리프레시 토큰도 인증 쿠키도 없어
 * (2026-08-03 실측) 재로그인이 유일한 갱신 수단이다. 그래서 서버 단독 실행이 불가능하고,
 * 네이버 세션이 살아 있는 크롬 프로필을 하나 유지하며 그걸로 브라우저를 띄운다.
 *
 * 프로필 디렉토리 자체가 자격증명이다 — iCloud 동기 폴더 밖에 둔다(기본값이 이미 그렇다).
 */

import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

export const PARTNER = 'https://partner.spacecloud.kr';

/** 일상 크롬 프로필과 섞지 않는다. 자동화가 로그인 상태를 건드려도 사람 브라우저가 안 흔들린다. */
export const PROFILE_DIR =
  process.env.SC_PROFILE_DIR || path.join(os.homedir(), '.typelounge', 'spacecloud-profile');

/** JWT의 exp(초)를 밀리초로. 서명은 검증하지 않는다 — 만료 판단에만 쓴다. */
function decodeExp(token) {
  const part = String(token).split('.')[1];
  if (!part) return null;

  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return exp ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * 현재 페이지의 localStorage에서 토큰을 읽는다.
 * localStorage는 origin별이라 partner 도메인에 있을 때만 의미가 있다.
 */
export async function readToken(page) {
  if (!page.url().startsWith(PARTNER)) return { valid: false, reason: '파트너 도메인이 아님' };

  const raw = await page.evaluate(() => localStorage.getItem('spacecloud__userInfo')).catch(() => null);
  if (!raw) return { valid: false, reason: '로그아웃 상태' };

  let token;
  try {
    token = JSON.parse(raw).accessToken;
  } catch {
    return { valid: false, reason: 'userInfo 형식을 해석하지 못함' };
  }
  if (!token) return { valid: false, reason: 'accessToken 없음' };

  const exp = decodeExp(token);
  if (!exp) return { valid: false, reason: 'exp 클레임 없음' };
  if (Date.now() >= exp) return { valid: false, reason: '토큰 만료', exp };

  return { valid: true, token, exp };
}

/**
 * 전용 프로필로 크롬을 띄운다.
 *
 * headless를 기본값으로 두지 않는다 — 네이버·Cloudflare가 헤드리스를 탐지하면 로그인이 막히고,
 * 그 실패는 "토큰 못 받음"으로만 보여서 원인 추적이 어렵다. 시스템 크롬(channel)을 쓰는 이유도
 * 같다: 번들 크로미움보다 탐지 표면이 작다.
 */
export async function openContext({ headless = false } = {}) {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul'
  });
}

/** 페이지 이동을 기록한다. 로그인이 막혔을 때 어디서 멈췄는지가 유일한 단서다. */
export function trackNavigation(page, onNavigate) {
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) onNavigate(frame.url());
  });
}

/** 토큰이 생길 때까지 폴링한다. URL 패턴에 의존하지 않아 리다이렉트 경로가 바뀌어도 버틴다. */
export async function waitForToken(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const t = await readToken(page);
    if (t.valid) return t;
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(1000);
  }
}

/** 로그인 페이지에서 네이버 버튼을 찾는다. a/button 어느 쪽으로 바뀌어도 잡히게 둔다. */
export async function findNaverButton(page) {
  const candidate = page.locator('a, button').filter({ hasText: /네이버/ }).first();
  return (await candidate.count()) > 0 ? candidate : null;
}

/**
 * 사람 개입 없이 토큰을 확보한다. 이미 유효하면 그대로 쓰고, 아니면 네이버 OAuth를 한 번 시도한다.
 *
 * **재시도하지 않는다.** 네이버 세션이 죽었을 때 로그인을 반복 두드리면 계정이 잠긴다
 * (ThinQ PAT 401을 재시도하지 않는 것과 같은 이유 — CLAUDE.md). 실패는 그대로 올려보내고
 * 호출자가 사람에게 알린다.
 */
export async function acquireToken(page, { timeoutMs = 60000, log = () => {} } = {}) {
  await page.goto(`${PARTNER}/reservation`, { waitUntil: 'domcontentloaded' });

  const existing = await readToken(page);
  if (existing.valid) {
    log('기존 세션 유효');
    return existing;
  }
  log(`세션 없음 (${existing.reason}) — 네이버 OAuth 시도`);

  await page.goto(`${PARTNER}/auth/login`, { waitUntil: 'domcontentloaded' });

  const naver = await findNaverButton(page);
  if (!naver) throw new Error('로그인 페이지에서 네이버 버튼을 찾지 못했습니다.');

  await naver.click();

  const token = await waitForToken(page, timeoutMs);
  if (!token) {
    throw new Error(
      `네이버 리다이렉트 후에도 토큰이 생기지 않았습니다 (${Math.round(timeoutMs / 1000)}초 대기). ` +
        `마지막 URL: ${page.url()}`
    );
  }
  return token;
}
