// Извлекает данные товаров из скачанного зеркала old_version/site
// -> old_version/products.json, products.md, categories.json
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SITE = base('../old_version/site');
const OUT = base('../old_version/products.json');
const OUT_CAT = base('../old_version/categories.json');
const OUT_MD = base('../old_version/products.md');

// --- утилиты ---
const decodeEnt = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
  .replace(/&amp;/g, '&');

const stripTags = (s) => decodeEnt(
  s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ''))
  .replace(/[ \t ]+/g, ' ')
  .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const metaVal = (html, prop, attr = 'itemprop') => {
  const re = new RegExp(`<meta[^>]+${attr}=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${prop}["']`, 'i');
  const m = html.match(re) || html.match(re2);
  return m ? decodeEnt(m[1]).trim() : '';
};

// вырезает сбалансированный <div>…</div>, начиная с позиции открывающего тега
function sliceDiv(html, start) {
  let depth = 0, i = start;
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
    if (re.lastIndex > start + 200000) break;
  }
  return html.slice(start, start + 20000);
}

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name === 'index.html') yield p;
  }
}

const urlOf = (file) => 'https://axelnn.ru/' +
  relative(SITE, file).split(sep).slice(0, -1).join('/') + '/';
const localOf = (file) => 'site/' + relative(SITE, file).split(sep).join('/');

// --- карточка товара ---
function parseProduct(html, file) {
  const isProduct = /itemtype=["']http:\/\/schema\.org\/Product["']/.test(html)
    && /setViewedProduct\(/.test(html);
  if (!isProduct) return null;

  const name = metaVal(html, 'name') || metaVal(html, 'og:title', 'property');
  if (!name) return null;

  // описание: мета — чистый текст, tabs_section — с абзацами/списками
  const descMeta = metaVal(html, 'description');
  let descHtml = '';
  const tabIdx = html.search(/<div[^>]*class=["'][^"']*tabs_section[^"']*["']/i);
  if (tabIdx !== -1) {
    const block = sliceDiv(html, tabIdx);
    // отрезаем всё до заголовка «Описание», если он есть
    const h = block.search(/<h4[^>]*>\s*Описание\s*<\/h4>/i);
    descHtml = h !== -1 ? block.slice(h).replace(/<h4[^>]*>\s*Описание\s*<\/h4>/i, '') : block;
  }
  const description = stripTags(descHtml) || descMeta;

  // цены
  const prices = [...html.matchAll(/<meta[^>]+itemprop=["']price["'][^>]*content=["']([\d.]+)["']/gi)]
    .map(m => parseFloat(m[1])).filter(n => n > 0);
  const low = parseFloat(metaVal(html, 'lowPrice')) || null;
  const high = parseFloat(metaVal(html, 'highPrice')) || null;
  const price = low ?? (prices.length ? Math.min(...prices) : null);
  const priceMax = high ?? (prices.length ? Math.max(...prices) : null);

  // старая цена (до скидки)
  const oldM = html.match(/class=["'][^"']*(?:old_price|price_old)[^"']*["'][^>]*>\s*<?[^<]*?([\d\s ]{3,})/i);
  const oldPrice = oldM ? parseFloat(oldM[1].replace(/[\s ]/g, '')) || null : null;

  // размеры и прочие варианты
  const sizes = [...new Set([...html.matchAll(/title=["']Размер:\s*([^"']+)["']/gi)].map(m => decodeEnt(m[1]).trim()))];
  const variants = {};
  for (const m of html.matchAll(/title=["']([А-Яа-яЁё][А-Яа-яЁё \-]{1,18}):\s*([^"']{1,40})["']/g)) {
    const k = m[1].trim(), v = decodeEnt(m[2]).trim();
    if (k === 'Размер') continue;
    (variants[k] ||= new Set()).add(v);
  }
  for (const k in variants) variants[k] = [...variants[k]];

  // изображения: оригиналы (без resize_cache), только из карточки товара
  const imgs = new Set();
  const ogImg = metaVal(html, 'og:image', 'property').replace(/^https?:\/\/axelnn\.ru/, '');
  if (ogImg) imgs.add(ogImg);
  const mainIdx = html.search(/<div[^>]*class=["'][^"']*item_main_info[^"']*["']/i);
  const scope = mainIdx !== -1 ? sliceDiv(html, mainIdx) : html;
  for (const m of scope.matchAll(/["'](\/upload\/iblock\/[^"'\s]+?\.(?:jpe?g|png|gif|webp))["']/gi)) imgs.add(m[1]);

  // стикеры (Новинка, Хит, Акция)
  const stickers = [...new Set([...html.matchAll(/class=["']sticker_[^"']*["'][^>]*>([^<]+)</gi)].map(m => decodeEnt(m[1]).trim()))];

  const category = metaVal(html, 'category');
  const brandM = name.match(/\b(Edea|Risport|Jackson|Riedell|Graf|Runa|Wifa|John Wilson|MK|Eclipse|Paramount|Chloe Noel|Sagester)\b/i);
  const brand = brandM ? brandM[1] : (description.match(/Производитель:\s*([A-Za-zА-Яа-я]+)/) || [])[1] || '';

  const available = /schema\.org\/InStock/.test(html);
  const offerCount = parseInt(metaVal(html, 'offerCount')) || (sizes.length || 1);

  return {
    id: metaVal(html, 'sku') || (file.split(sep).slice(-2, -1)[0] || ''),
    name,
    url: urlOf(file),
    localFile: localOf(file),
    category,
    brand,
    price, priceMax, oldPrice, currency: 'RUB',
    available,
    offerCount,
    stickers,
    sizes,
    variants,
    mainImage: [...imgs][0] || null,
    images: [...imgs],
    description,
    descriptionHtml: descHtml.trim(),
  };
}

// --- раздел каталога ---
function parseCategory(html, file) {
  const url = urlOf(file);
  if (!url.includes('/catalog/')) return null;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1) return null;
  const title = stripTags(h1[1]);
  if (!title) return null;
  const items = [...new Set([...html.matchAll(/href=["'](\/catalog\/[^"'?#]*?\/\d+\/)["']/g)].map(m => m[1]))];
  return {
    title, url, localFile: localOf(file),
    depth: url.replace('https://axelnn.ru/catalog/', '').replace(/\/$/, '').split('/').filter(Boolean).length,
    productLinks: items.length,
  };
}

// --- main ---
const products = [], categories = [], pages = [];
let scanned = 0;

for await (const file of walk(SITE)) {
  scanned++;
  let html;
  try { html = await readFile(file, 'utf8'); } catch { continue; }
  const p = parseProduct(html, file);
  if (p) { products.push(p); continue; }
  const c = parseCategory(html, file);
  if (c) { categories.push(c); continue; }
  const t = (html.match(/<title>([^<]+)<\/title>/i) || [])[1];
  if (t) pages.push({ title: decodeEnt(t).trim(), url: urlOf(file), localFile: localOf(file) });
}

const uniq = new Map();
for (const p of products) {
  const prev = uniq.get(p.url);
  if (!prev || p.description.length > prev.description.length) uniq.set(p.url, p);
}
const list = [...uniq.values()].sort((a, b) =>
  (a.category || '').localeCompare(b.category || '', 'ru') || a.name.localeCompare(b.name, 'ru'));

await writeFile(OUT, JSON.stringify({
  site: 'https://axelnn.ru',
  exported: '2026-07-20',
  count: list.length,
  products: list,
}, null, 2), 'utf8');

await writeFile(OUT_CAT, JSON.stringify({
  categories: categories.sort((a, b) => a.url.localeCompare(b.url)),
  otherPages: pages.sort((a, b) => a.url.localeCompare(b.url)),
}, null, 2), 'utf8');

// читаемая версия
let md = `# Товары axelnn.ru\n\nВыгружено 20.07.2026 — **${list.length}** товаров.\n\n`;
let cur = null;
for (const p of list) {
  if (p.category !== cur) { cur = p.category; md += `\n---\n\n## ${cur || 'Без категории'}\n\n`; }
  md += `### ${p.name}\n\n`;
  md += `- Артикул: \`${p.id}\` · [страница](${p.url})\n`;
  md += `- Цена: **${p.price ? p.price.toLocaleString('ru') + ' ₽' : '—'}**`;
  if (p.priceMax && p.priceMax !== p.price) md += ` … ${p.priceMax.toLocaleString('ru')} ₽`;
  if (p.oldPrice) md += ` (было ${p.oldPrice.toLocaleString('ru')} ₽)`;
  md += `\n`;
  if (p.brand) md += `- Бренд: ${p.brand}\n`;
  if (p.stickers.length) md += `- Метки: ${p.stickers.join(', ')}\n`;
  if (p.sizes.length) md += `- Размеры: ${p.sizes.join(', ')}\n`;
  for (const [k, v] of Object.entries(p.variants)) md += `- ${k}: ${v.join(', ')}\n`;
  md += `- Фото (${p.images.length}): ${p.images.map(i => `\`${i}\``).join(' ')}\n`;
  if (p.description) md += `\n${p.description}\n`;
  md += `\n`;
}
await writeFile(OUT_MD, md, 'utf8');

const withDesc = list.filter(p => p.description.length > 30).length;
console.log(`Просканировано HTML: ${scanned}`);
console.log(`Товаров: ${list.length}`);
console.log(`  с описанием: ${withDesc}`);
console.log(`  с ценой: ${list.filter(p => p.price).length}`);
console.log(`  с размерами: ${list.filter(p => p.sizes.length).length}`);
console.log(`  с категорией: ${list.filter(p => p.category).length}`);
console.log(`Разделов каталога: ${categories.length}`);
console.log(`Прочих страниц: ${pages.length}`);
console.log(`Уникальных фото: ${new Set(list.flatMap(p => p.images)).size}`);
