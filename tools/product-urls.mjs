// Собирает список ВСЕХ карточек товаров, упомянутых где-либо в скачанных страницах,
// и проверяет, скачана ли базовая версия каждой (без ?oid=).
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SITE = base('../old_version/site');
const OUT = base('../old_version/_product-urls.json');

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.html')) yield p;
  }
}

const toPath = (u) => {
  let p = decodeURIComponent(new URL(u).pathname) + 'index.html';
  return join(SITE, p.split('/').map(s => s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/, '')).join('/'));
};
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const products = new Set();
let scanned = 0;

for await (const file of walk(SITE)) {
  scanned++;
  let html;
  try { html = await readFile(file, 'utf8'); } catch { continue; }
  // ссылки на карточки: /catalog/<раздел>[/<подраздел>]/<числовой id>/
  for (const m of html.matchAll(/href=["'](\/catalog\/[^"'?#]*?\/\d+\/)(?:[?#][^"']*)?["']/g)) {
    products.add('https://axelnn.ru' + m[1]);
  }
}

const missing = [];
for (const u of products) if (!(await exists(toPath(u)))) missing.push(u);

await writeFile(OUT, JSON.stringify({
  scannedHtml: scanned,
  totalProducts: products.size,
  missing,
  all: [...products].sort(),
}, null, 2), 'utf8');

console.log(`Просканировано HTML: ${scanned}`);
console.log(`Найдено карточек товаров (уникальных): ${products.size}`);
console.log(`Из них не скачано: ${missing.length}`);
if (missing.length) console.log('Примеры:', missing.slice(0, 5));
