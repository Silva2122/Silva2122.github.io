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
const ROOT = base('../..');
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

// Галерея страницы товара: кадр там показывается на ~600 логических пикселей,
// на ретине это 1200, но оригиналы донора часто и не дотягивают до такого —
// 1000 берём как потолок, withoutEnlargement не даст растянуть мелкий.
const GSIZE = Number(arg('--gallery-size', 1000));
const GMAX = Number(arg('--gallery-max', 6));   // больше шести миниатюр никто не листает

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

// «RUNA», «Runa», «EDEA», «Edea», «JACKSON» — одна марка в четырёх написаниях.
// Приводим к одному виду, аббревиатуры оставляем как есть.
const KEEP_CAPS = new Set(['MK']);
function brandName(b) {
  const s = (b || '').trim();
  if (!s) return null;
  if (KEEP_CAPS.has(s.toUpperCase())) return s.toUpperCase();
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

// В размерах донора попадается мусор: прочерк вместо значения и пустые строки.
// Такой «размер» в фильтре — пункт, который ничего не отбирает.
function cleanSizes(list) {
  const out = [];
  for (const s of list || []) {
    const v = String(s).trim();
    if (!v || v === '-' || v === '—') continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

mkdirSync(OUT, { recursive: true });

const list = LIMIT ? products.slice(0, LIMIT) : products;
const manifest = [];
let cut = 0, raw = 0, skipped = 0, cached = 0, failed = 0;
let shotsMade = 0, shotsCached = 0;

// Кадры для галереи на странице товара: вырезанный идёт первым (он на прозрачном
// фоне и в едином масштабе), дальше оригиналы по убыванию разрешения. Дедуп по
// имени файла: вырезанный и его оригинал — один и тот же кадр, и в галерее они
// стояли бы рядом как «два ракурса».
function gallerySources(p) {
  const seen = new Set();
  const out = [];
  for (const im of p.images || []) {
    const hash = im.slice(im.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (byHash.has(hash)) {
      out.push({ src: join(NOBG, byHash.get(hash)), px: Infinity });
      continue;
    }
    const d = dim(im);
    const px = d ? Math.min(d[0], d[1]) : 0;
    if (px >= MIN_PX) out.push({ src: join(SITE, im.replace(/^\//, '')), px });
  }
  return out.sort((a, b) => b.px - a.px).slice(0, GMAX);
}

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

  // --- галерея страницы товара ---
  const gallery = [];
  for (const [n, shot] of gallerySources(p).entries()) {
    const gname = `${p.id}-${n + 1}.webp`;
    const gdest = join(OUT, gname);
    if (!FORCE && existsSync(gdest)) {
      gallery.push(`assets/img/products/${gname}`);
      shotsCached++;
      continue;
    }
    try {
      await sharp(shot.src)
        .resize(GSIZE, GSIZE, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY, alphaQuality: 100 })
        .toFile(gdest);
      gallery.push(`assets/img/products/${gname}`);
      shotsMade++;
    } catch (e) {
      console.log(`  кадр ${gname}: ${e.message}`);
    }
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
    // Крупные кадры для страницы товара. Пустой массив — фото нет вовсе,
    // страница обойдётся плейсхолдером.
    gallery,
    cut: kind === 'cut',
    // Для фильтров на странице раздела. Бренд в доноре набран как придётся
    // (RUNA, Runa, EDEA, Edea) — сводим регистр, иначе одна марка даёт
    // четыре разных пункта в фильтре.
    brand: brandName(p.brand),
    sizes: cleanSizes(p.sizes),
  });

  if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${list.length}…`);
}

writeFileSync(join(ROOT, 'assets', 'products.json'), JSON.stringify(manifest), 'utf8');

console.log(`\nГотово. Товаров: ${manifest.length}`);
console.log(`  вырезанных кадров : ${cut}`);
console.log(`  оригиналов        : ${raw}`);
console.log(`  уже были на диске : ${cached}`);
console.log(`  без годного фото  : ${skipped}`);
console.log(`  кадров галереи    : ${shotsMade} новых, ${shotsCached} уже были`);
if (failed) console.log(`  ошибок            : ${failed}`);
console.log(`Манифест: assets/products.json`);
