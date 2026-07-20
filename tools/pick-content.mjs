// Отбирает товары и картинки из донора для главной страницы и копирует фото в assets/.
//
// Правило, ради которого скрипт существует: НЕЛЬЗЯ брать p.mainImage — это часто
// превью 133×200. Годное фото ищется перебором всего p.images[] по реальным размерам
// из заголовка файла. Из 1416 товаров пригодных к карточке (мин. сторона >=600) — 1117.
//
//   node tools/pick-content.mjs          отобрать и скопировать
//   node tools/pick-content.mjs --dry    только показать, ничего не копировать
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');
const SITE = join(ROOT, 'old_version', 'site');
const DRY = process.argv.includes('--dry');

// Размеры из заголовка файла — без зависимостей, читаем только начало.
function dim(rel) {
  try {
    const b = readFileSync(join(SITE, rel));
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

// Лучшее фото товара = максимальная минимальная сторона среди всех images[]
function bestPhoto(p) {
  let px = 0, path = null, size = null;
  for (const im of p.images || []) {
    const d = dim(im);
    if (!d) continue;
    const m = Math.min(d[0], d[1]);
    if (m > px) { px = m; path = im; size = d; }
  }
  return { px, path, size };
}

const { products } = JSON.parse(readFileSync(join(ROOT, 'old_version', 'products.json'), 'utf8'));

// Отчёт image-audit.mjs: какие кадры сняты на ровном светлом фоне. Разрешения мало —
// снимок 3024×3024 на асфальте в круглой плитке рядом со студийным выглядит чужим.
let studio = new Set();
try {
  const q = JSON.parse(readFileSync(join(ROOT, 'old_version', '_image-quality.json'), 'utf8'));
  studio = new Set(q.studio.map((i) => i.img));
  console.log(`Студийных кадров в отчёте: ${studio.size}`);
} catch {
  console.log('Нет _image-quality.json — сначала прогони tools/image-audit.mjs');
}

const pool = [];
for (const p of products) {
  if (!p.price || !p.available) continue;
  const b = bestPhoto(p);
  if (b.px < 700) continue;
  if (studio.size && !studio.has(b.path)) continue;
  pool.push({
    name: p.name.trim(), price: p.price, url: p.url.replace('https://axelnn.ru', ''),
    cat: p.category || '', img: b.path, px: b.px, size: b.size.join('×'),
  });
}
console.log(`Товаров с пригодным фото (>=700px): ${pool.length} из ${products.length}`);

const l1 = (c) => c.split('/')[0].trim();
const byCat = {};
for (const p of pool) (byCat[l1(p.cat)] ||= []).push(p);

// --- витрина: разные разделы, дорогое и заметное ---
const want = [
  'Ботинки для фигурного катания', 'Фигурные коньки', 'Лезвия',
  'Сумки,рюкзаки', 'Защита фигуриста', 'Аксессуары для льда',
];
const showcase = [];
for (const c of want) {
  const best = (byCat[c] || []).sort((a, b) => b.price - a.price)[0];
  if (best) showcase.push(best);
}

// --- вторая лента: одежда, самая полно отснятая группа ---
const clothes = (byCat['Одежда для девочек'] || [])
  .sort((a, b) => b.price - a.price)
  .filter((p, i, arr) => arr.findIndex((x) => x.name.slice(0, 18) === p.name.slice(0, 18)) === i)
  .slice(0, 8);

// --- по одному кадру на категорию ---
const catImages = {};
for (const [c, list] of Object.entries(byCat)) {
  catImages[c] = list.sort((a, b) => b.px - a.px)[0];
}

function emit(title, list) {
  console.log(`\n=== ${title} (${list.length}) ===`);
  for (const p of list) {
    console.log(`  ${String(p.price).padStart(7)}  ${p.size.padStart(10)}  ${p.name.slice(0, 52)}`);
  }
}
emit('Витрина', showcase);
emit('Одежда', clothes);
console.log(`\n=== Категории (${Object.keys(catImages).length}) ===`);
for (const [c, p] of Object.entries(catImages)) console.log(`  ${c.padEnd(34)} ${p.size.padStart(10)}  ${p.name.slice(0, 34)}`);

if (DRY) { console.log('\n--dry: файлы не копировались'); process.exit(0); }

// --- копирование ---
const outImg = join(ROOT, 'assets', 'img', 'catalog');
mkdirSync(outImg, { recursive: true });

let n = 0;
// Кириллица в имени файла доживёт до боевого сервера и там сломается — транслитерируем.
const RU = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
const slug = (s) => s.toLowerCase().replace(/[а-яё]/g, (c) => RU[c] ?? '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 44);
const attach = (p, prefix) => {
  const ext = p.img.slice(p.img.lastIndexOf('.'));
  const file = `${prefix}-${slug(p.name)}${ext}`;
  copyFileSync(join(SITE, p.img), join(outImg, file));
  n++;
  return { ...p, local: `assets/img/catalog/${file}` };
};

const data = {
  showcase: showcase.map((p) => attach(p, 'item')),
  clothes: clothes.map((p) => attach(p, 'item')),
  categories: Object.fromEntries(Object.entries(catImages).map(([c, p]) => [c, attach(p, 'cat')])),
};

writeFileSync(join(ROOT, 'assets', 'content.json'), JSON.stringify(data, null, 2), 'utf8');
console.log(`\nСкопировано изображений: ${n} → assets/img/catalog/`);
console.log('Данные: assets/content.json');
