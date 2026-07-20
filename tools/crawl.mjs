// Краулер axelnn.ru -> old_version/site (зеркало с сохранением оригинальных путей)
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ORIGIN = 'https://axelnn.ru';
const ROOT = new URL('../old_version/site/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const STATE = new URL('../old_version/_crawl-state.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CONCURRENCY = 10;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// --- очередь ---
const seen = new Set();      // все url, что уже поставлены в очередь
const queue = [];            // {url, type: 'page'|'asset'}
const failed = [];
let done = 0;

const SKIP_RE = /(\/bitrix\/(?!cache|js|templates|panel|components)|compare\.php|\/personal\/|\/auth\/|\/cart\/|\/basket\/|\/search\/|\/local\/|\/upload\/resize_cache\/webp\/|action=|login=|register=|logout=|forgot_password=|change_password=|back_url|backurl|print=|clear_cache|bxajaxid|view_result|utm_|ADD_TO_COMPARE|SORT_FIELD|ORDER_BY|[?&](?:sort|order|display|mode)=|set_filter|del_filter|arrFilter|\/click\/|mailto:|tel:|javascript:|#)/i;
const ASSET_RE = /\.(jpe?g|png|gif|svg|webp|ico|css|js|woff2?|ttf|eot|otf|mp4|webm|pdf)(\?|$)/i;

function normalize(raw, base) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.protocol = 'https:';
  u.hash = '';
  if (u.hostname !== 'axelnn.ru' && u.hostname !== 'www.axelnn.ru') return null;
  u.hostname = 'axelnn.ru';
  // выкидываем кэш-бастеры у ассетов
  if (ASSET_RE.test(u.pathname)) u.search = '';
  return u.toString();
}

// url -> путь на диске
function toPath(urlStr) {
  const u = new URL(urlStr);
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z0-9]{2,5}$/i.test(p)) p += '/index.html';
  if (u.search) {
    const q = u.search.replace(/[^a-z0-9=_-]/gi, '_').slice(0, 60);
    p = p.replace(/(\.html)$/, `__${q}$1`);
  }
  // чистим недопустимые для Windows символы + пробелы/точки в конце сегмента (их FS не хранит)
  p = p.split('/').map(s => s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/, '')).join('/');
  return join(ROOT, p);
}

function push(urlStr, type) {
  if (!urlStr || seen.has(urlStr)) return;
  if (SKIP_RE.test(urlStr)) return;
  seen.add(urlStr);
  queue.push({ url: urlStr, type });
}

// --- парсинг ---
function extractFromHtml(html, base) {
  const links = new Set(), assets = new Set();
  const attrRe = /(?:href|src|data-src|data-original|data-big|data-lazyload|content|srcset)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    for (const part of m[1].split(',')) {
      const raw = part.trim().split(/\s+/)[0];
      if (!raw || raw.startsWith('data:')) continue;
      const n = normalize(raw, base);
      if (!n) continue;
      (ASSET_RE.test(new URL(n).pathname) ? assets : links).add(n);
    }
  }
  // url() внутри inline-стилей
  const cssRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  while ((m = cssRe.exec(html))) {
    if (m[1].startsWith('data:')) continue;
    const n = normalize(m[1], base);
    if (n) assets.add(n);
  }
  // js-галереи Aspro часто хранят пути прямо в json внутри html
  const jsonImg = /["'](\/upload\/[^"']+?\.(?:jpe?g|png|gif|webp))["']/gi;
  while ((m = jsonImg.exec(html))) {
    const n = normalize(m[1], base);
    if (n) assets.add(n);
  }
  return { links: [...links], assets: [...assets] };
}

function extractFromCss(css, base) {
  const out = new Set();
  const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].startsWith('data:')) continue;
    const n = normalize(m[1], base);
    if (n) out.add(n);
  }
  const imp = /@import\s+(?:url\()?['"]([^'"]+)['"]/gi;
  while ((m = imp.exec(css))) {
    const n = normalize(m[1], base);
    if (n) out.add(n);
  }
  return [...out];
}

// --- загрузка ---
async function fetchRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(45000),
      });
      if (r.status === 404 || r.status === 410) return { skip: true, status: r.status };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { res: r };
    } catch (e) {
      if (i === tries - 1) return { error: e.message };
      await new Promise(s => setTimeout(s, 800 * (i + 1)));
    }
  }
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function handle(job) {
  const path = toPath(job.url);
  if (await exists(path)) { done++; return; }

  const r = await fetchRetry(job.url);
  if (r.skip) { done++; return; }
  if (r.error) { failed.push({ url: job.url, error: r.error }); done++; return; }

  const res = r.res;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);

  if (ct.includes('text/html')) {
    const html = buf.toString('utf8');
    const { links, assets } = extractFromHtml(html, job.url);
    for (const a of assets) push(a, 'asset');
    for (const l of links) push(l, 'page');
  } else if (ct.includes('css') || job.url.endsWith('.css')) {
    for (const a of extractFromCss(buf.toString('utf8'), job.url)) push(a, 'asset');
  }
  done++;
}

// --- воркеры ---
async function run() {
  await mkdir(ROOT, { recursive: true });

  push(ORIGIN + '/', 'page');
  // seed из sitemap
  try {
    const sm = await (await fetch(ORIGIN + '/sitemap.xml', { headers: { 'User-Agent': UA } })).text();
    for (const m of sm.matchAll(/<loc>([^<]+)<\/loc>/g)) push(normalize(m[1].trim(), ORIGIN), 'page');
  } catch {}

  let last = 0;
  const timer = setInterval(() => {
    if (done !== last) {
      last = done;
      console.log(`[${done}/${seen.size}] в очереди: ${queue.length}, ошибок: ${failed.length}`);
    }
  }, 3000);

  let active = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const job = queue.shift();
      if (!job) {
        // очередь пуста: выходим только когда никто больше не качает
        if (active === 0) break;
        await new Promise(s => setTimeout(s, 200));
        continue;
      }
      active++;
      try { await handle(job); } catch (e) { failed.push({ url: job.url, error: String(e) }); done++; }
      finally { active--; }
    }
  });
  await Promise.all(workers);
  clearInterval(timer);

  await writeFile(STATE, JSON.stringify({
    total: seen.size, downloaded: done, failed,
    urls: [...seen].sort(),
  }, null, 2), 'utf8');

  console.log(`\nГотово. Всего: ${seen.size}, скачано: ${done}, ошибок: ${failed.length}`);
}

run();
