// Общий запуск браузера для shot.mjs и audit.mjs.
//
// Браузер НЕ качаем: берём chromium из кэша Playwright, который уже есть в системе.
// Версия там зафиксирована (1228) — это важнее, чем свежесть: системный Chrome
// автообновляется, и тогда «регрессии» на скриншотах окажутся сменой сглаживания.
import { chromium } from 'playwright-core';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const LOCAL = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local');

// По убыванию предпочтения: пиннутый chromium -> его headless-вариант -> системный Chrome/Edge
const CANDIDATES = [
  join(LOCAL, 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe'),
  join(LOCAL, 'ms-playwright', 'chromium_headless_shell-1228', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

async function findBrowser() {
  for (const p of CANDIDATES) {
    try { await access(p); return p; } catch {}
  }
  throw new Error(
    'Не найден ни один браузер. Ожидались:\n  ' + CANDIDATES.join('\n  ') +
    '\nПоставить можно так: npx playwright install chromium'
  );
}

// Флаги против дрожания рендера между запусками. Без них половина «изменений»
// на скриншотах — это разное сглаживание шрифтов, а не правки вёрстки.
const STABLE_FLAGS = [
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--disable-skia-runtime-opts',
  '--force-color-profile=srgb',
  '--disable-web-security',
];

export async function launch() {
  const executablePath = await findBrowser();
  const browser = await chromium.launch({ executablePath, args: STABLE_FLAGS });
  return { browser, executablePath };
}

/**
 * Открывает страницу и ждёт, пока она реально готова к съёмке:
 * сеть успокоилась, шрифты применились, анимации доиграли.
 */
export async function openPage(browser, url, { width, height = 900 } = {}) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
  });

  const errors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => failed.push({ url: r.url(), reason: r.failure()?.errorText }));
  page.on('response', (r) => { if (r.status() >= 400) failed.push({ url: r.url(), reason: `HTTP ${r.status()}` }); });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  // Шрифты грузятся с Google Fonts — без этого снимем фолбэк вместо Playfair.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);

  return { page, errors, failed };
}
