// Докачивает всё, что verify.mjs записал в old_version/_missing.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SITE = base('../old_version/site');
const MISSING = base('../old_version/_missing.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CONCURRENCY = 10;

function toPath(urlStr) {
  const u = new URL(urlStr);
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z0-9]{2,5}$/i.test(p)) p += '/index.html';
  if (u.search) p = p.replace(/(\.html)$/, `__${u.search.replace(/[^a-z0-9=_-]/gi, '_').slice(0, 60)}$1`);
  p = p.split('/').map(s => s.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/, '')).join('/');
  return join(SITE, p);
}

// можно передать свой json: node fetch-missing.mjs old_version/_product-urls.json
const src = process.argv[2] ? base('../' + process.argv[2].replace(/^\.?\/?/, '').replace(/^old_version\//, 'old_version/')) : MISSING;
const data = JSON.parse(await readFile(src, 'utf8'));
const jobs = [...(data.missingPages || []), ...(data.missingAssets || []), ...(data.missing || [])];
console.log(`К докачке: ${jobs.length}`);

let i = 0, ok = 0, fail = 0;
const failed = [];

async function worker() {
  while (i < jobs.length) {
    const url = jobs[i++];
    let saved = false;
    for (let t = 0; t < 3 && !saved; t++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
        if (r.status === 404 || r.status === 410) { saved = true; break; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        const p = toPath(url);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, buf);
        ok++; saved = true;
      } catch (e) {
        if (t === 2) { fail++; failed.push({ url, error: e.message }); }
        else await new Promise(s => setTimeout(s, 700 * (t + 1)));
      }
    }
    if ((ok + fail) % 100 === 0) console.log(`  ${ok + fail}/${jobs.length} (ошибок: ${fail})`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`Готово. Скачано: ${ok}, ошибок: ${fail}`);
if (failed.length) console.log(failed.slice(0, 10));
