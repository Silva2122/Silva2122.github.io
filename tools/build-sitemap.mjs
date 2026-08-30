// Строит sitemap.xml по уже собранным страницам сайта.
//
//   node tools/build-sitemap.mjs
//
// Не пересобирает список разделов и товаров заново (это уже сделали
// build-catalog.mjs и build-products.mjs с учётом tools/visible.mjs), а
// обходит диск и берёт canonical из каждой найденной страницы — так
// sitemap не может разойтись с тем, что реально лежит на сайте.
// Запускать последним, после build-pages/build-catalog/build-products.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');

// /cart/ и /favorites/ сюда не входят: у них нет собственного контента
// (рисуются из localStorage) и стоит <meta name="robots" content="noindex">.
const SITE_DIRS = ['catalog', 'company', 'help', 'services', 'contacts', 'info'];

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name === 'index.html') yield p;
  }
}

const urls = [];

function addIfIndexable(file) {
  const html = readFileSync(file, 'utf8');
  if (/<meta\s+name="robots"\s+content="noindex">/i.test(html)) return;
  const m = html.match(/<link rel="canonical" href="([^"]+)">/);
  if (m) urls.push(m[1]);
}

addIfIndexable(join(ROOT, 'index.html'));
for (const dir of SITE_DIRS) {
  for (const file of walk(join(ROOT, dir))) addIfIndexable(file);
}

urls.sort();

const body = urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n');
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;

writeFileSync(join(ROOT, 'sitemap.xml'), xml, 'utf8');
console.log(`sitemap.xml: ${urls.length} адресов`);
