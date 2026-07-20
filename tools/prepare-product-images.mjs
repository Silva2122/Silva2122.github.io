// Готовит картинки товаров для страниц разделов и манифест к ним.
//
// Оригиналы донора весят по 1-2 МБ и доходят до 3000px — класть их на страницу,
// где полторы сотни карточек, нельзя. Карточка занимает ~280 логических пикселей,
// на ретине это 560, поэтому приводим всё к 600 и жмём в webp.
//
// Где кадр уже вырезан (.shots/nobg/birefnet, 336 штук) — берём вырезанный:
// он на прозрачном фоне и в едином масштабе. Остальным достаётся оригинал:
// это временно, до следующего прогона remove-bg.mjs.
//
//   node tools/prepare-product-images.mjs             все товары
//   node tools/prepare-product-images.mjs --limit 50  первые 50, для проверки
//   node tools/prepare-product-images.mjs --force     перегенерировать существующие
//
// Результат: assets/img/products/<id>.webp + assets/products.json
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');
const SITE = join(ROOT, 'old_version', 'site');
const NOBG = join(ROOT, '.shots', 'nobg', 'birefnet');
const OUT = join(ROOT, 'assets', 'img', 'products');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', 0));
const FORCE = argv.includes('--force');
const SIZE = Number(arg('--size', 600));
const QUALITY = Number(arg('--quality', 80));
const MIN_PX = 400;   // мельче — карточка растягивает кадр в кашу

const { products } = JSON.parse(readFileSync(join(ROOT, 'old_version', 'products.json'), 'utf8'));

// Вырезанные лежат под именем «<номер>_<хэш исходника>.webp» — хэш и есть
// имя файла оригинала, по нему и связываем.
const nobg = existsSync(NOBG) ? readdirSync(NOBG).filter((f) => f.endsWith('.webp')) : [];
const byHash = new Map(nobg.map((f) => [f.replace(/^\d+_/, '').replace(/\.webp$/, ''), f]));
console.log(`Вырезанных кадров в пуле: ${byHash.size}`);

// Размеры из заголовка файла. Читаем первые 64 КБ, а не файл целиком: у товара
// до десятка кадров по паре мегабайт, и на 1416 товарах полное чтение вылилось бы
// в десяток гигабайт ради четырёх чисел на каждый файл.
function head(path, bytes = 65536) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function dim(rel) {
  try {
    const b = head(join(SITE, rel.replace(/^\//, '')));
    if (b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  } catch {}
  return null;
}

mkdirSync(OUT, { recursive: true });

const list = LIMIT ? products.slice(0, LIMIT) : products;
const manifest = [];
let cut = 0, raw = 0, skipped = 0, cached = 0, failed = 0;

for (const [i, p] of list.entries()) {
  if (!p.id) continue;

  // 1. Есть ли вырезанный кадр хоть для одной из картинок товара
  let src = null, kind = null;
  for (const im of p.images || []) {
    const hash = im.slice(im.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    if (byHash.has(hash)) { src = join(NOBG, byHash.get(hash)); kind = 'cut'; break; }
  }

  // 2. Иначе самый крупный оригинал. mainImage не годится — это часто превью 133×200.
  if (!src) {
    let px = 0, best = null;
    for (const im of p.images || []) {
      const d = dim(im);
      if (!d) continue;
      const m = Math.min(d[0], d[1]);
      if (m > px) { px = m; best = im; }
    }
    if (best && px >= MIN_PX) { src = join(SITE, best.replace(/^\//, '')); kind = 'raw'; }
  }

  const name = `${p.id}.webp`;
  const dest = join(OUT, name);

  if (src && !FORCE && existsSync(dest)) {
    cached++;
  } else if (src) {
    try {
      // fit: 'inside' — кадры уже квадратные у вырезанных и разные у оригиналов;
      // подгонять оригинал под квадрат кропом нельзя, срежет товар.
      await sharp(src)
        .resize(SIZE, SIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY, alphaQuality: 100 })
        .toFile(dest);
      if (kind === 'cut') cut++; else raw++;
    } catch (e) {
      console.log(`  ошибка ${p.id}: ${e.message}`);
      failed++;
      src = null;
    }
  } else {
    skipped++;
  }

  manifest.push({
    id: p.id,
    name: (p.name || '').trim(),
    price: p.price ?? null,
    oldPrice: p.oldPrice ?? null,
    available: p.available !== false,
    cat: p.category || '',
    url: (p.url || '').replace('https://axelnn.ru', ''),
    img: src ? `assets/img/products/${name}` : null,
    cut: kind === 'cut',
  });

  if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${list.length}…`);
}

writeFileSync(join(ROOT, 'assets', 'products.json'), JSON.stringify(manifest), 'utf8');

console.log(`\nГотово. Товаров: ${manifest.length}`);
console.log(`  вырезанных кадров : ${cut}`);
console.log(`  оригиналов        : ${raw}`);
console.log(`  уже были на диске : ${cached}`);
console.log(`  без годного фото  : ${skipped}`);
if (failed) console.log(`  ошибок            : ${failed}`);
console.log(`Манифест: assets/products.json`);
