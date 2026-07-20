// Собирает пачку изображений в одну PNG-простыню с подписями.
// Нужен, чтобы отсматривать фотофонд глазами: водяные знаки, зашитый текст,
// разнобой масштаба и фона видно только при сравнении кадров рядом.
//
//   node tools/contact-sheet.mjs assets/img/catalog        всё из папки
//   node tools/contact-sheet.mjs --cat "Одежда для девочек" --n 24   кандидаты раздела
import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './serve.mjs';
import { launch } from './browser.mjs';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const dirArg = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
const CAT = arg('--cat', null);
const N = Number(arg('--n', 40));
const COLS = Number(arg('--cols', 6));

let items, serveRoot;

if (CAT) {
  // кандидаты раздела из отчёта image-audit
  const q = JSON.parse(readFileSync(join(ROOT, 'old_version', '_image-quality.json'), 'utf8'));
  items = [...q.studio, ...q.mid]
    .filter((i) => i.cat === CAT)
    .slice(0, N)
    .map((i) => ({ src: i.img, label: `${i.name.slice(0, 30)} · фон ${i.mean}/${i.sd}` }));
  serveRoot = join(ROOT, 'old_version', 'site');
} else {
  const dir = dirArg || 'assets/img/catalog';
  items = readdirSync(join(ROOT, dir))
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .slice(0, N)
    .map((f) => ({ src: '/' + dir.replace(/\\/g, '/') + '/' + f, label: f.slice(0, 34) }));
  serveRoot = ROOT;
}

console.log(`Кадров: ${items.length}`);

const server = await startServer({ root: serveRoot, port: 0, quiet: true });
const { browser } = await launch();

try {
  const page = await browser.newPage({ viewport: { width: COLS * 230 + 40, height: 800 }, deviceScaleFactor: 1 });
  // Без перехода на сервер документ живёт на about:blank, и пути вида /assets/…
  // разрешать не от чего — получится простыня из пустых рамок.
  await page.goto(server.url + '/', { waitUntil: 'domcontentloaded' });

  const cells = items.map((i) => `
    <figure style="margin:0">
      <div style="aspect-ratio:1;background:#fff;border:1px solid #D8DDDD;overflow:hidden;display:grid;place-items:center">
        <img src="${i.src}" style="max-width:100%;max-height:100%;object-fit:contain" loading="eager">
      </div>
      <figcaption style="font:11px/1.35 ui-monospace,monospace;color:#1E2A2C;padding:5px 2px 0">${i.label}</figcaption>
    </figure>`).join('');

  await page.setContent(`<body style="margin:0;padding:20px;background:#EAEBEB;
    display:grid;grid-template-columns:repeat(${COLS},210px);gap:16px">${cells}</body>`);

  await page.evaluate(async () => {
    await Promise.race([
      Promise.all([...document.images].filter((i) => !i.complete)
        .map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
      new Promise((r) => setTimeout(r, 15000)),
    ]);
  });

  const out = join(ROOT, '.shots', arg('--out', 'contact-sheet.png'));
  writeFileSync(out, await page.screenshot({ fullPage: true }));
  console.log(`Простыня: ${out}`);
} finally {
  await browser.close();
  await server.close();
}
