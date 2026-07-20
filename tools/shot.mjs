// Скриншоты страниц. Дорогой инструмент — для эстетики: ритм, воздух, баланс.
// Всё, что проверяется программно, должно ловиться audit.mjs, а не глазами.
//
//   node tools/shot.mjs /                     контакт-лист: все ширины в одном PNG
//   node tools/shot.mjs / --full --w 1440     вся страница целиком на одной ширине
//   node tools/shot.mjs / --fold              только первый экран, все ширины
//   node tools/shot.mjs / --sel ".card"       один компонент крупно
//   node tools/shot.mjs /catalog/ --root old_version/site    страница донора
//
// Опции: --w 390,768,1440,1920 | --clip 2200 | --h 1100 | --out файл.png
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { startServer } from './serve.mjs';
import { launch, openPage } from './browser.mjs';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const urlPath = argv.find((a) => a.startsWith('/')) || '/';
const widths = arg('--w', '390,768,1440,1920').split(',').map(Number).filter(Boolean);
const clipH = Number(arg('--clip', 2200));   // сколько пикселей страницы берём в контакт-лист
const sheetH = Number(arg('--h', 1100));     // высота готового листа
const selector = arg('--sel', null);
const serverRoot = resolve(ROOT, arg('--root', '.'));

const mode = flag('--full') ? 'full' : flag('--fold') ? 'fold' : selector ? 'sel' : 'sheet';

const slug = urlPath.replace(/^\/|\/$/g, '').replace(/[^a-z0-9а-я_-]+/gi, '-') || 'home';
const outDir = join(ROOT, '.shots', slug);

// Снимок одной ширины. Возвращает PNG-буфер и реальные размеры кадра.
async function capture(browser, url, width, { full, clip, sel }) {
  const { page, errors, failed } = await openPage(browser, url, { width });
  try {
    if (sel) {
      const el = page.locator(sel).first();
      if (!(await el.count())) throw new Error(`Селектор не найден: ${sel}`);
      const box = await el.boundingBox();
      return { buf: await el.screenshot(), w: Math.round(box.width), h: Math.round(box.height), errors, failed };
    }

    const pageH = await page.evaluate(() => document.documentElement.scrollHeight);

    if (full) {
      return { buf: await page.screenshot({ fullPage: true }), w: width, h: pageH, errors, failed };
    }

    const h = Math.min(clip, pageH);
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width, height: h } });
    return { buf, w: width, h, errors, failed };
  } finally {
    await page.close();
  }
}

// Склейка колонок в один PNG. Масштаб общий для всех ширин, поэтому по вертикали
// во всех колонках виден один и тот же кусок страницы, а разница ширин — как есть.
async function composeSheet(browser, shots) {
  const scale = sheetH / Math.max(...shots.map((s) => s.h));
  const cols = shots.map((s) => `
    <figure style="margin:0;flex:0 0 auto">
      <figcaption style="font:600 13px/1.6 ui-monospace,monospace;color:#1E2A2C;padding-bottom:6px">
        ${s.width}px
      </figcaption>
      <img src="data:image/png;base64,${s.buf.toString('base64')}"
           style="display:block;width:${Math.round(s.w * scale)}px;height:${Math.round(s.h * scale)}px;
                  border:1px solid #D8DDDD;background:#fff">
    </figure>`).join('');

  const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(`<body style="margin:0;padding:16px;background:#EAEBEB;display:inline-flex;
      gap:16px;align-items:flex-start">${cols}</body>`);
    const box = await page.locator('body').boundingBox();
    await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
    return await page.screenshot({ fullPage: true });
  } finally {
    await page.close();
  }
}

// --- main ---
const server = await startServer({ root: serverRoot, port: 0, quiet: true });
const { browser, executablePath } = await launch();
const problems = [];

try {
  const url = server.url + urlPath;
  await mkdir(outDir, { recursive: true });

  if (mode === 'sheet' || mode === 'fold') {
    const shots = [];
    for (const width of widths) {
      const s = await capture(browser, url, width, { clip: mode === 'fold' ? 900 : clipH });
      shots.push({ ...s, width });
      problems.push(...s.errors, ...s.failed.map((f) => `${f.reason} — ${f.url}`));
    }
    const out = arg('--out', join(outDir, mode === 'fold' ? 'fold.png' : 'sheet.png'));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, await composeSheet(browser, shots));
    console.log(`Контакт-лист: ${out}`);
    console.log(`Ширины: ${shots.map((s) => `${s.width}→${s.h}px`).join(', ')}`);
  } else {
    const width = widths[0];
    const s = await capture(browser, url, width, { full: mode === 'full', sel: selector });
    problems.push(...s.errors, ...s.failed.map((f) => `${f.reason} — ${f.url}`));
    const name = mode === 'sel' ? `sel-${selector.replace(/[^a-z0-9]+/gi, '-')}.png` : `full-${width}.png`;
    const out = arg('--out', join(outDir, name));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, s.buf);
    console.log(`Снимок: ${out}  (${s.w}×${s.h})`);
  }

  const uniq = [...new Set(problems)];
  if (uniq.length) {
    console.log(`\nПроблемы при загрузке (${uniq.length}):`);
    for (const p of uniq.slice(0, 12)) console.log('  ' + p);
  }
  console.log(`\nБраузер: ${executablePath.split('\\').slice(-3).join('\\')}`);
} finally {
  await browser.close();
  await server.close();
}
