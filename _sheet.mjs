// Собирает результаты remove-bg в одну простыню для отсмотра.
// Прозрачность кладём на серый фон сайта — на белом не видно ни рваных краёв,
// ни светлого ореола, ради которых всё и затевалось.
import sharp from 'sharp';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2] || '.shots/nobg/rmbg';
const CELL = Number(process.argv[3] || 380);
const COLS = 4;
const BG = { r: 234, g: 235, b: 235, alpha: 1 };  // --canvas сайта

const files = readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();
const rep = JSON.parse(readFileSync(join(DIR, '_report.json'), 'utf8'));
const byFile = new Map(rep.items.filter((i) => i.file).map((i) => [i.file, i]));

const rows = Math.ceil(files.length / COLS);
const cells = [];

for (const [i, f] of files.entries()) {
  const img = await sharp(join(DIR, f))
    .resize(CELL - 16, CELL - 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const cell = await sharp({ create: { width: CELL, height: CELL, channels: 4, background: BG } })
    .composite([{ input: img, gravity: 'center' }])
    .png().toBuffer();
  cells.push({ input: cell, left: (i % COLS) * CELL, top: Math.floor(i / COLS) * CELL });
}

const sheet = await sharp({
  create: { width: COLS * CELL, height: rows * CELL, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
}).composite(cells).png().toBuffer();

const out = DIR.replace(/[\\/]/g, '-') + '-sheet.png';
writeFileSync(out, sheet);
console.log(`Простыня: ${out}  (${files.length} кадров, ${COLS}x${rows})`);
for (const f of files) {
  const it = byFile.get(f);
  if (it) console.log(`  ${f.slice(0, 3)} покрытие ${(it.coverage * 100).toFixed(0)}%  ${it.name.slice(0, 36)}`);
}
