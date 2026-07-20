// Оценивает пригодность фотографий донора для premium-вёрстки.
//
// Разрешение — не единственный критерий. Снимок 3024×3024, сделанный на асфальте,
// в круглой плитке рядом со студийным кадром выглядит как чужой. Поэтому меряем
// однородность фона: берём рамку по краю кадра и считаем среднюю яркость и разброс.
// Студийный кадр — светлая рамка с малым разбросом. Репортаж — тёмная и пёстрая.
//
//   node tools/image-audit.mjs                отчёт по всем товарам с фото >=700px
//   node tools/image-audit.mjs --limit 200    быстрее, на выборке
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');
const SITE = join(ROOT, 'old_version', 'site');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', 0));

function dim(rel) {
  try {
    const b = readFileSync(join(SITE, rel));
    if (b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + b.readUInt16BE(i + 2);
    }
  } catch {}
  return null;
}

const { products } = JSON.parse(readFileSync(join(ROOT, 'old_version', 'products.json'), 'utf8'));

const items = [];
for (const p of products) {
  let px = 0, path = null;
  for (const im of p.images || []) {
    const d = dim(im);
    if (!d) continue;
    const m = Math.min(d[0], d[1]);
    if (m > px) { px = m; path = im; }
  }
  if (px >= 700) items.push({ name: p.name.trim(), cat: (p.category || '').split('/')[0].trim(), img: path, px });
}
const list = LIMIT ? items.slice(0, LIMIT) : items;
console.log(`Анализирую ${list.length} фотографий...`);

const server = await startServer({ root: SITE, port: 0, quiet: true });
const { browser } = await launch();

try {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  await page.goto(server.url + '/', { waitUntil: 'domcontentloaded' });

  const results = await page.evaluate(async (paths) => {
    const out = [];
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const S = 64;
    cv.width = S; cv.height = S;

    for (const src of paths) {
      const img = new Image();
      const ok = await new Promise((r) => { img.onload = () => r(true); img.onerror = () => r(false); img.src = src; });
      if (!ok) { out.push(null); continue; }

      ctx.clearRect(0, 0, S, S);
      ctx.drawImage(img, 0, 0, S, S);
      const d = ctx.getImageData(0, 0, S, S).data;
      const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

      // рамка шириной 4px по периметру — это фон, а не предмет
      const edge = [];
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          if (x > 3 && x < S - 4 && y > 3 && y < S - 4) continue;
          edge.push(lum((y * S + x) * 4));
        }
      }
      const mean = edge.reduce((a, b) => a + b, 0) / edge.length;
      const sd = Math.sqrt(edge.reduce((a, b) => a + (b - mean) ** 2, 0) / edge.length);
      out.push({ mean: +mean.toFixed(1), sd: +sd.toFixed(1) });
    }
    return out;
  }, list.map((i) => i.img));

  const scored = list.map((it, i) => ({ ...it, ...(results[i] || {}) }))
    .filter((it) => it.mean !== undefined);

  // студийный кадр: светлый ровный фон
  const studio = (it) => it.mean >= 205 && it.sd <= 26;
  const okish = (it) => !studio(it) && it.mean >= 175 && it.sd <= 42;

  const good = scored.filter(studio);
  const mid = scored.filter(okish);
  const bad = scored.filter((it) => !studio(it) && !okish(it));

  console.log(`\nСтудийный ровный фон : ${good.length}`);
  console.log(`Приемлемо            : ${mid.length}`);
  console.log(`Пёстрый фон / съёмка : ${bad.length}`);

  const byCat = {};
  for (const it of scored) {
    const b = (byCat[it.cat] ||= { all: 0, good: 0 });
    b.all++; if (studio(it)) b.good++;
  }
  console.log('\nПо разделам (студийных / всего с фото >=700px):');
  for (const [c, b] of Object.entries(byCat).sort((a, b) => b[1].good - a[1].good)) {
    console.log(`  ${c.slice(0, 32).padEnd(34)} ${String(b.good).padStart(4)} / ${String(b.all).padStart(4)}`);
  }

  writeFileSync(join(ROOT, 'old_version', '_image-quality.json'),
    JSON.stringify({ studio: good, mid, bad }, null, 2), 'utf8');
  console.log('\nОтчёт: old_version/_image-quality.json');
} finally {
  await browser.close();
  await server.close();
}
