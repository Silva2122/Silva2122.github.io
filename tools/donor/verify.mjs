// Сверяет: все ли ссылки со скачанных страниц реально сохранены на диск.
// Пишет список недостающего в old_version/_missing.json (его скармливаем fetch-missing.mjs)
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SITE = base('../../old_version/site');
const OUT = base('../../old_version/_missing.json');

const ASSET_RE = /\.(jpe?g|png|gif|svg|webp|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|pdf)(\?|$)/i;
const SKIP_RE = /(\/bitrix\/(?!cache|js|templates|panel|components)|compare\.php|\/personal\/|\/auth\/|\/cart\/|\/basket\/|\/search\/|\/local\/|action=|login=|register=|logout=|forgot_password=|change_password=|back_url|backurl|print=|clear_cache|bxajaxid|view_result|utm_|ADD_TO_COMPARE|SORT_FIELD|ORDER_BY|[?&](?:sort|order|display|mode)=|set_filter|del_filter|arrFilter|\/click\/|mailto:|tel:|javascript:)/i;

function normalize(raw, base) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.protocol = 'https:'; u.hash = '';
  if (!/^(www\.)?axelnn\.ru$/.test(u.hostname)) return null;
  u.hostname = 'axelnn.ru';
  if (ASSET_RE.test(u.pathname)) u.search = '';
  return u.toString();
}

function toPath(urlStr) {
  const u = new URL(urlStr);
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z0-9]{2,5}$/i.test(p)) p += '/index.html';
  if (u.search) p = p.replace(/(\.html)$/, `__${u.search.replace(/[^a-z0-9=_-]/gi, '_').slice(0, 60)}$1`);
  p = p.split('/').map(s => s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/, '')).join('/');
  return join(SITE, p);
}

const urlOf = (file) => {
  let rel = file.slice(SITE.length).replace(/\\/g, '/').replace(/^\//, '');
  rel = rel.replace(/index\.html$/, '');
  return 'https://axelnn.ru/' + rel.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/');
};

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

const referenced = new Set();
let htmlCount = 0;

for await (const file of walk(SITE)) {
  if (!file.endsWith('.html')) continue;
  htmlCount++;
  let html;
  try { html = await readFile(file, 'utf8'); } catch { continue; }
  const pageUrl = urlOf(file);

  // обычные атрибуты — URL целиком (запятая в нём легальна)
  const attrRe = /(?:href|src|data-src|data-original|data-big|data-lazyload)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('data:')) continue;
    const n = normalize(raw, pageUrl);
    if (n && !SKIP_RE.test(n)) referenced.add(n);
  }
  // srcset — вот здесь запятая действительно разделитель
  const srcsetRe = /srcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcsetRe.exec(html))) {
    for (const part of m[1].split(',')) {
      const raw = part.trim().split(/\s+/)[0];
      if (!raw || raw.startsWith('data:')) continue;
      const n = normalize(raw, pageUrl);
      if (n && !SKIP_RE.test(n)) referenced.add(n);
    }
  }
  const upl = /["'](\/upload\/[^"'\s]+?\.(?:jpe?g|png|gif|webp|svg))["']/gi;
  while ((m = upl.exec(html))) {
    const n = normalize(m[1], pageUrl);
    if (n) referenced.add(n);
  }
  const cssUrl = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  while ((m = cssUrl.exec(html))) {
    if (m[1].startsWith('data:')) continue;
    const n = normalize(m[1], pageUrl);
    if (n && !SKIP_RE.test(n)) referenced.add(n);
  }
}

// ссылки из скачанных CSS
for await (const file of walk(SITE)) {
  if (!file.endsWith('.css')) continue;
  let css;
  try { css = await readFile(file, 'utf8'); } catch { continue; }
  const cssUrlBase = urlOf(file);
  let m;
  const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  while ((m = re.exec(css))) {
    if (m[1].startsWith('data:')) continue;
    const n = normalize(m[1], cssUrlBase);
    if (n) referenced.add(n);
  }
}

const missingPages = [], missingAssets = [];
for (const u of referenced) {
  const parsed = new URL(u);
  // битые ссылки самого сайта: путь с закодированным путём внутри (%2Fcatalog%2F…)
  if (parsed.pathname.includes('%2F')) continue;
  const isAsset = ASSET_RE.test(parsed.pathname);
  // страницы с параметрами (?oid=, сортировки) — намеренные дубли, их не проверяем
  if (!isAsset && parsed.search && !/^\?PAGEN_\d+=\d+$/.test(parsed.search)) continue;
  if (await exists(toPath(u))) continue;
  (isAsset ? missingAssets : missingPages).push(u);
}

await writeFile(OUT, JSON.stringify({
  scannedHtml: htmlCount,
  referenced: referenced.size,
  missingPages: missingPages.sort(),
  missingAssets: missingAssets.sort(),
}, null, 2), 'utf8');

console.log(`HTML просканировано: ${htmlCount}`);
console.log(`Всего ссылок: ${referenced.size}`);
console.log(`Не хватает страниц: ${missingPages.length}`);
console.log(`Не хватает файлов (фото/css/js): ${missingAssets.length}`);
if (missingPages.length) console.log('Примеры страниц:', missingPages.slice(0, 5));
if (missingAssets.length) console.log('Примеры файлов:', missingAssets.slice(0, 5));
