// Текстовый аудит вёрстки. Дешёвый инструмент — гонять после каждой правки.
// Ловит то, что не требует глаз: переполнения, контраст, мыло на картинках, битые ассеты.
// Эстетику (ритм, воздух, композицию) он не проверяет — для этого shot.mjs.
//
//   node tools/audit.mjs /                     все ширины
//   node tools/audit.mjs / --w 390             одна ширина
//   node tools/audit.mjs /catalog/ --root old_version/site
import { resolve } from 'node:path';
import { startServer } from './serve.mjs';
import { launch, openPage } from './browser.mjs';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const urlPath = argv.find((a) => a.startsWith('/')) || '/';
const widths = arg('--w', '390,768,1440,1920').split(',').map(Number).filter(Boolean);
const serverRoot = resolve(ROOT, arg('--root', '.'));

// Выполняется внутри страницы.
function collect() {
  const R = { overflowX: null, wide: [], contrast: [], blurry: [], imgMeta: [], fonts: {}, weight: 0, lcp: null };
  const doc = document.documentElement;

  if (doc.scrollWidth > doc.clientWidth) {
    R.overflowX = { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
    // кто именно вылезает за правый край вьюпорта
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > doc.clientWidth + 1) {
        R.wide.push({ sel: sel(el), right: Math.round(r.right), width: Math.round(r.width) });
      }
    }
    R.wide = R.wide.slice(0, 10);
  }

  function sel(el) {
    const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
  }

  // --- контраст ---
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const alpha = (c) => { const p = (c.match(/[\d.]+/g) || []); return p.length > 3 ? Number(p[3]) : 1; };

  // Возвращает null, если под текстом фотография или градиент: тогда контраст
  // вычислить нельзя, и предупреждать не о чем — это работа для глаз, а не для формулы.
  function bgOf(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      // текст поверх абсолютно позиционированного слоя с картинкой-соседом
      if (cs.position === 'absolute' && n.parentElement?.querySelector('img')) return null;
      if (cs.backgroundColor && alpha(cs.backgroundColor) > 0.5) return parse(cs.backgroundColor);
    }
    return [255, 255, 255];
  }

  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const txt = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!txt) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;

    const fg = parse(cs.color);
    const bg = bgOf(el);
    if (!bg) continue;                 // текст лежит на фото — формулой не проверить
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      const key = sel(el) + cs.color + cs.fontSize;
      if (seen.has(key)) continue;
      seen.add(key);
      R.contrast.push({
        sel: sel(el), ratio: +ratio.toFixed(2), need,
        color: cs.color, size: Math.round(size),
        text: (el.textContent || '').trim().slice(0, 38),
      });
    }
  }

  // --- картинки ---
  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    if (!r.width) continue;
    const need = Math.round(r.width);
    if (img.naturalWidth && img.naturalWidth < need * 0.95) {
      R.blurry.push({ src: img.currentSrc.split('/').pop(), natural: img.naturalWidth, rendered: need });
    }
    const miss = [];
    // alt="" — законная пометка «картинка декоративная», а не пропуск
    if (img.getAttribute('alt') === null) miss.push('alt');
    if (!img.getAttribute('width')) miss.push('width');
    if (!img.getAttribute('height')) miss.push('height');
    if (miss.length) R.imgMeta.push({ src: img.currentSrc.split('/').pop(), miss });
  }

  // --- шрифты: применились или отрисовался фолбэк ---
  for (const f of ['Montserrat', 'Playfair Display']) {
    R.fonts[f] = document.fonts.check(`16px "${f}"`);
  }

  // На localhost transferSize нередко 0 — берём распакованный размер тела.
  const size = (r) => r.decodedBodySize || r.encodedBodySize || r.transferSize || 0;
  const nav = performance.getEntriesByType('resource');
  R.weight = Math.round(nav.reduce((s, r) => s + size(r), 0) / 1024);
  const heaviest = nav.slice().sort((a, b) => size(b) - size(a))[0];
  if (heaviest) R.lcp = { url: heaviest.name.split('/').pop().slice(0, 40), kb: Math.round(size(heaviest) / 1024) };

  return R;
}

// --- main ---
const server = await startServer({ root: serverRoot, port: 0, quiet: true });
const { browser } = await launch();
let bad = 0;

try {
  console.log(`Аудит ${urlPath}\n${'='.repeat(56)}`);

  for (const width of widths) {
    const { page, errors, failed } = await openPage(browser, server.url + urlPath, { width });
    const R = await page.evaluate(collect);
    await page.close();

    const lines = [];
    if (R.overflowX) {
      lines.push(`ПЕРЕПОЛНЕНИЕ ПО ГОРИЗОНТАЛИ: ${R.overflowX.scrollWidth} > ${R.overflowX.clientWidth}`);
      for (const w of R.wide) lines.push(`    ${w.sel} — правый край ${w.right}px, ширина ${w.width}px`);
    }
    for (const c of R.contrast) {
      lines.push(`контраст ${c.ratio}:1 (нужно ${c.need}) — ${c.sel} ${c.size}px «${c.text}»`);
    }
    for (const b of R.blurry) {
      lines.push(`картинка растянута: ${b.src} — исходник ${b.natural}px, показан на ${b.rendered}px`);
    }
    for (const f of Object.entries(R.fonts)) {
      if (!f[1]) lines.push(`шрифт НЕ применился: ${f[0]} — отрисован фолбэк`);
    }
    const noAlt = R.imgMeta.filter((i) => i.miss.includes('alt'));
    if (noAlt.length) lines.push(`img без alt: ${noAlt.length} шт. (${noAlt.slice(0, 3).map((i) => i.src).join(', ')})`);
    const noDim = R.imgMeta.filter((i) => i.miss.includes('width') || i.miss.includes('height'));
    if (noDim.length) lines.push(`img без width/height (прыжки при загрузке): ${noDim.length} шт.`);
    for (const e of [...new Set(errors)].slice(0, 5)) lines.push(`ошибка JS: ${e}`);
    for (const f of [...new Set(failed.map((f) => `${f.reason} — ${f.url.split('/').slice(-2).join('/')}`))].slice(0, 5)) {
      lines.push(`не загрузилось: ${f}`);
    }

    bad += lines.length;
    console.log(`\n${width}px  ${lines.length ? `— ${lines.length} замечаний` : '— чисто'}`);
    for (const l of lines) console.log('  ' + l);
    if (width === widths[0]) console.log(`  вес страницы: ${R.weight} КБ, самый тяжёлый: ${R.lcp?.url} (${R.lcp?.kb} КБ)`);
  }

  console.log(`\n${'='.repeat(56)}\nВсего замечаний: ${bad}`);
} finally {
  await browser.close();
  await server.close();
}
