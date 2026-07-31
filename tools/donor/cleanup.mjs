// Удаляет дубли-страницы: ?oid=, сортировки, mode=xml, комбинации sort+PAGEN.
// Оставляет чистые страницы и PAGEN_1=N (списки товаров пригодятся для сверки).
import { readdir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SITE = base('../../old_version/site');
const DRY = process.argv.includes('--dry');

// мусор: всё с query, КРОМЕ чистой пагинации PAGEN_1=N
const JUNK = /__(?!PAGEN_1=\d+\.html$).+\.html$/;

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let removed = 0, bytes = 0;
const { stat } = await import('node:fs/promises');

for await (const f of walk(SITE)) {
  const name = f.split(/[\\/]/).pop();
  if (!JUNK.test(name)) continue;
  try {
    bytes += (await stat(f)).size;
    if (!DRY) await unlink(f);
    removed++;
  } catch {}
}

console.log(`${DRY ? '[dry-run] ' : ''}Удалено дублей: ${removed}`);
console.log(`Освобождено: ${(bytes / 1024 / 1024).toFixed(0)} МБ`);
