// Собирает разметку каталога из данных донора и вставляет её в страницы.
//
// Меню каталога — это 13 разделов и под сотню подразделов. Руками такой список
// не поддерживают: он разъезжается с данными на второй же правке. Поэтому
// разметка генерируется, а в HTML лежат маркеры, между которыми скрипт пишет
// результат. Всё, что вне маркеров, не трогается.
//
//   node tools/build-catalog.mjs          вставить меню в страницы
//   node tools/build-catalog.mjs --dry    показать, ничего не записывая
//
// Источники: assets/products.json (что показываем — картинки, цены, размеры),
// content/sections.json (заголовки, порядок и картинки разделов — их правит
// админка). Донор нужен только на чистой копии, где content/ ещё не собран:
// old_version/categories.json даёт URL разделов, old_version/products.json —
// оригиналы кадров. Обоих может не быть, и это не ошибка.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { splitVisible, HIDE_NO_PHOTO } from './visible.mjs';
import { loadSections, loadSite, digits } from './content.mjs';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');
const DRY = process.argv.includes('--dry');

const donorJSON = (name, key) => {
  const file = join(ROOT, 'old_version', name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))[key] || [] : [];
};

const categories = donorJSON('categories.json', 'categories');
const products = donorJSON('products.json', 'products');

// Разделы каталога: заголовок, порядок в меню, картинка на витрине.
// Раньше это были три таблицы прямо в коде (ORDER, TITLES, SECTION_IMG) —
// теперь они лежат в content/sections.json, и раздел переименовывается
// или переставляется из админки, а не правкой генератора.
const CONTENT_SECTIONS = loadSections();
const secByKey = new Map(CONTENT_SECTIONS.map((s) => [s.key, s]));

// Телефон — из content/site.json, а не строкой: иначе правка в админке
// до /cart/ не доедет, хотя шапка и подвал на той же странице её уже покажут.
const site = loadSite();
const phoneHref = digits(site.phone);
const phoneText = site.phone || '';

// Манифест готовит tools/prepare-product-images.mjs: он ужимает кадры и решает,
// какому товару достался вырезанный фон, а какому оригинал. Из него же берётся
// и состав меню — раньше меню считалось по донору, и в нём стояли счётчики
// вида «Одежда MSK 123», хотя на странице раздела карточек было втрое меньше.
const MANIFEST = join(ROOT, 'assets', 'products.json');
if (!existsSync(MANIFEST)) {
  console.error('Нет assets/products.json — сначала прогони tools/prepare-product-images.mjs');
  process.exit(1);
}
const catalogItems = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const { visible, hidden } = splitVisible(catalogItems);

// Порядок в меню — не алфавитный и не по числу товаров. Сначала то, за чем
// приходят в специализированный магазин (коньки, ботинки, лезвия), потом
// экипировка, в конце сувениры. Раздел, которого здесь нет, уедет в хвост.
const ORDER = [
  'Фигурные коньки',
  'Ботинки для фигурного катания',
  'Лезвия',
  'Одежда для девочек',
  'Одежда для мальчиков',
  'Одежда MSK',
  'Защита фигуриста',
  'Сумки,рюкзаки',
  'Хранение',
  'Аксессуары для льда',
  'Тренажеры',
  'Мешки для обуви',
  'Сувениры',
  'Подарочные наборы тренерам',
  'ЕДИНЫЙ КОМАНДНЫЙ СТИЛЬ',
];

// Названия в products.json и в заголовках страниц разошлись: у товара
// «Хранение», а у раздела «Хранение/уход за коньками». Слэш в имени раздела
// ломает и разбор category, поэтому связываем вручную.
const TITLES = {
  'Хранение': 'Хранение и уход',
  'Сумки,рюкзаки': 'Сумки и рюкзаки',
  'ЕДИНЫЙ КОМАНДНЫЙ СТИЛЬ': 'Единый командный стиль',
  'Тренажеры': 'Тренажёры',
};

const MAX_SUB = 6;   // подразделов в меню на раздел; остальные — за ссылкой «весь раздел»

// --- URL разделов ---------------------------------------------------------
// В categories.json заголовок страницы, в products.json — имя категории товара.
// Совпадают не всегда, поэтому сверяем по нормализованной форме.
const norm = (s) => s.toLowerCase().replace(/[ёе]/g, 'е').replace(/[^a-zа-я0-9]/gi, '');
const rel = (c) => c.url.replace('https://axelnn.ru', '');
const named = categories.filter((c) => c.depth >= 1);

// Раздел верхнего уровня ищем по всему дереву, беря самый неглубокий из тёзок.
const topUrl = (title) => {
  const hits = named.filter((c) => norm(c.title) === norm(title));
  if (!hits.length) return null;
  return rel(hits.sort((a, b) => a.depth - b.depth)[0]);
};

// А подраздел — только внутри своего родителя. Без этого «Термокостюмы»
// у мальчиков уводили на раздел девочек: заголовки в этих ветках совпадают
// дословно, и глобальный поиск по имени отдавал первое попавшееся совпадение.
const subUrl = (title, parent) => {
  if (!parent) return null;
  const hit = named.find((c) => norm(c.title) === norm(title) && rel(c).startsWith(parent) && rel(c) !== parent);
  return hit ? rel(hit) : null;
};

// --- дерево из товаров ----------------------------------------------------
// Адрес раздела берём из URL его товаров, а не из заголовков categories.json.
// Причина: зеркало докачано не полностью, и у «Одежды MSK» со 123 товарами
// страницы раздела на диске просто нет — по заголовку он не находился и раздел
// молча пропадал из каталога. Товар же всегда лежит по /catalog/<раздел>/…,
// так что путь восстанавливается из любого из них.
// Считаем по видимым товарам, а не по всему манифесту: раздел, из которого
// после скрытия ничего не осталось, не должен попасть ни в меню, ни в витрину.
const tree = new Map();
for (const p of visible) {
  const [top, sub] = (p.cat || '').split('/').map((s) => s.trim());
  if (!top) continue;
  const seg = (p.url || '').replace('https://axelnn.ru', '').split('/').filter(Boolean);
  // seg = ['catalog', <раздел>, (<подраздел>), <id>]
  const topSeg = seg[0] === 'catalog' ? seg[1] : null;
  const subSeg = seg[0] === 'catalog' && seg.length >= 4 ? seg[2] : null;

  if (!tree.has(top)) tree.set(top, { total: 0, subs: new Map(), paths: new Map() });
  const node = tree.get(top);
  node.total++;
  if (topSeg) node.paths.set(topSeg, (node.paths.get(topSeg) || 0) + 1);
  if (sub) {
    if (!node.subs.has(sub)) node.subs.set(sub, { count: 0, paths: new Map() });
    const s = node.subs.get(sub);
    s.count++;
    if (subSeg) s.paths.set(subSeg, (s.paths.get(subSeg) || 0) + 1);
  }
}

// У раздела может встретиться несколько путей (товар лежит в двух ветках) —
// берём тот, что встречается чаще.
const topPath = (paths) => [...paths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

// Порядок и заголовок берём из content/sections.json по сегменту адреса,
// а ORDER с TITLES остаются запасным вариантом для чистой копии без content/.
// Сортируем после map, а не до: до него у раздела ещё нет сегмента, а имя
// категории в данных донора к нему не сводится.
const rank = (s) => {
  const meta = secByKey.get(s.key);
  if (meta && Number.isFinite(meta.order)) return meta.order;
  const i = ORDER.indexOf(s.name);
  return i === -1 ? 99 : i;
};

const sections = [...tree.entries()]
  .map(([name, node]) => {
    const seg = topPath(node.paths);
    const url = seg ? `/catalog/${seg}/` : topUrl(name);
    return {
      key: seg,
      name,
      title: secByKey.get(seg)?.title || TITLES[name] || name,
      url,
      total: node.total,
      subs: [...node.subs.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([t, s]) => {
          const sub = topPath(s.paths);
          // Подраздел — не отдельная страница, а якорь внутри страницы раздела:
          // в половине подразделов меньше десятка товаров, ради них плодить
          // девяносто файлов незачем.
          return { title: t, count: s.count, anchor: sub, url: sub ? `${url}#${sub}` : subUrl(t, url) };
        })
        .filter((s) => s.url),
    };
  })
  .filter((s) => s.url)   // без адреса ссылку не построить
  .sort((a, b) => rank(a) - rank(b));

console.log(`Разделов: ${sections.length}, товаров: ${visible.length} из ${catalogItems.length}`);
if (HIDE_NO_PHOTO && hidden.length) {
  console.log(`Скрыто без фото: ${hidden.length} — вернутся сами, как только появятся кадры`);
}
for (const s of sections) {
  console.log(`  ${String(s.total).padStart(4)}  ${s.title.padEnd(32)} ${s.subs.length} подразделов`);
}

// Раздел целиком без видимых товаров — отдельной строкой в лог: молча
// исчезнувший из меню раздел выглядит как поломка генератора.
const hiddenSections = new Map();
for (const p of hidden) {
  const top = (p.cat || '').split('/')[0].trim();
  const seg = (p.url || '').split('/').filter(Boolean)[1];
  if (!top || tree.has(top)) continue;
  if (!hiddenSections.has(top)) hiddenSections.set(top, { n: 0, seg });
  hiddenSections.get(top).n++;
}
for (const [name, { n, seg }] of hiddenSections) {
  console.log(`  скрыт раздел целиком: ${name} (${n} товаров без фото, /catalog/${seg}/)`);
}

// --- разметка меню --------------------------------------------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Названия в Битриксе набиты без пробела после запятой: «Термобрюки,термолосины,
// термоюбки,термошорты» браузер считает одним длинным словом и не переносит —
// строка вылезала в соседнюю колонку меню. Ставим пробелы, заодно снимаем
// точку в конце («Колготки,носки.») и сдвоенные пробелы.
const tidy = (s) => s
  .replace(/,(?=\S)/g, ', ')
  .replace(/\s+/g, ' ')
  .replace(/\s*\.\s*$/, '')
  .trim();

// Ссылки внутренние и абсолютные от корня: страницы лежат на разной глубине
// (/, /catalog/, /catalog/figure-skates/), и относительный путь в общей шапке
// пришлось бы пересчитывать под каждую. В адресах донора попадаются пробелы
// (`termovodolazki 1/`) — кодируем, иначе ссылка обрывается на пробеле.
const href = (path) => path.split('/').map(encodeURIComponent).join('/').replace(/%23/g, '#');
// Неразрывный пробел перед коротким последним словом — чтобы «для льда»
// не отрывалось от «Аксессуары» переносом внутри узкой колонки.
const nb = (s) => s.replace(/ (\S{1,4})$/, ' $1');

const SITE = 'https://axelnn.ru';

function menuMarkup(indent) {
  const pad = ' '.repeat(indent);
  const cols = sections.map((s) => {
    const subs = s.subs.slice(0, MAX_SUB).map((sub) =>
      `${pad}      <a class="megamenu__link" href="${href(sub.url)}"><span class="megamenu__name">${esc(tidy(sub.title))}</span><span class="megamenu__count">${sub.count}</span></a>`
    );
    if (s.subs.length > MAX_SUB) {
      subs.push(`${pad}      <a class="megamenu__link megamenu__link--more" href="${href(s.url)}">Ещё ${s.subs.length - MAX_SUB}</a>`);
    }
    return [
      `${pad}    <div class="megamenu__group">`,
      `${pad}      <a class="megamenu__title" href="${href(s.url)}">${esc(tidy(s.title))}</a>`,
      ...subs,
      `${pad}    </div>`,
    ].join('\n');
  });

  return [
    `${pad}<div class="megamenu" id="megamenu">`,
    `${pad}  <div class="megamenu__inner">`,
    cols.join('\n'),
    `${pad}  </div>`,
    `${pad}</div>`,
  ].join('\n');
}

// --- вставка между маркерами ---------------------------------------------
const START = '<!-- КАТАЛОГ:МЕНЮ:НАЧАЛО -->';
const END = '<!-- КАТАЛОГ:МЕНЮ:КОНЕЦ -->';

// Заменяет содержимое между маркерами ОБЩЕЕ:<name> или КАТАЛОГ:МЕНЮ.
// Возвращает новый html или null, если маркеров нет.
function replaceBlock(html, start, end, build) {
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from === -1 || to === -1) return null;

  // Отступ маркера задаёт отступ вставки — иначе сгенерированный блок
  // выпадает из форматирования файла и diff становится нечитаемым.
  const lineStart = html.lastIndexOf('\n', from) + 1;
  const indent = from - lineStart;

  return html.slice(0, from + start.length) + '\n' + build(indent) + '\n' + ' '.repeat(indent) + html.slice(to);
}

function inject(file) {
  const path = join(ROOT, file);
  if (!existsSync(path)) { console.log(`  пропуск, нет файла: ${file}`); return; }
  const html = readFileSync(path, 'utf8');
  // Страницы разделов и товаров собираются целиком ниже и в build-products.mjs,
  // причём из той же главной — вставлять в них меню отдельно незачем.
  if (html.includes('Страницу целиком собирает')) return;

  const next = replaceBlock(html, START, END, menuMarkup);
  if (next === null) { console.log(`  пропуск, нет маркеров: ${file}`); return; }
  if (next === html) { console.log(`  без изменений: ${file}`); return; }
  if (!DRY) writeFileSync(path, next, 'utf8');
  console.log(`  ${DRY ? '[dry] ' : ''}меню обновлено: ${file}`);
}

// Шапка одинакова на всех страницах, а меню каталога в ней — сгенерированное.
// Правка в одном файле без остальных разошлась бы с ними на первой же правке
// данных, поэтому обходим все страницы сайта. Список не держим руками: страниц
// разделов пятнадцать, и они сами появляются ниже в этом же прогоне — ручной
// перечень отстал бы от них на один запуск.
// admin/ обходим стороной: это не страница сайта, а интерфейс владельца.
// Маркеров ОБЩЕЕ:* в нём нет, но и меню каталога с шапкой магазина там ни к чему.
const SKIP_DIRS = new Set(['node_modules', 'old_version', 'tools', 'admin', 'content']);

function pages(dir = ROOT, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) pages(p, acc);
    // relative(), а не арифметика по длине ROOT: у ROOT есть завершающий слэш,
    // и slice(ROOT.length + 1) срезал первый символ пути — «catalog/» превращался
    // в «atalog/», после чего все страницы молча пропускались как несуществующие.
    else if (e.name.endsWith('.html')) acc.push(relative(ROOT, p).replace(/\\/g, '/'));
  }
  return acc;
}

console.log('\nВставка меню:');
const PAGES = pages();
PAGES.forEach(inject);

// ==========================================================================
// Страница каталога
// ==========================================================================

// Картинка раздела. Где кадр уже вырезан и лежит рядом с главной — берём его:
// раздел должен выглядеть одинаково в кружке на главной и в каталоге.
// Где вырезанного нет — ключ hash берёт кадр из общего пула .shots/nobg/,
// а null означает «вырезанного не существует, ставим оригинал из донора».
const SECTION_IMG = {
  'Фигурные коньки': { file: 'cat-konki-figurnye-runa-base.webp' },
  'Ботинки для фигурного катания': { file: 'cat-figurnye-botinki-edea-overture-belye-1.webp' },
  'Лезвия': { file: 'cat-lezviya-dlya-konkov-mk-professional.webp' },
  'Одежда для девочек': { file: 'cat-kolgotki-so-strazami-art-1152.webp' },
  'Защита фигуриста': { file: 'cat-zaschita-zapyastya-sprinter.webp' },
  'Хранение': { file: 'cat-termochehly-na-botinok-chernye.webp' },
  'Сумки,рюкзаки': { file: 'cat-ryukzak-runa-kotyata.webp' },
  'Тренажеры': { file: 'cat-spinner-disk-panda.webp' },
  // Ниже — вырезанные есть в пуле, но на главной они не используются.
  'Аксессуары для льда': { hash: 'xpeu7e008v77b5xhr6iy2110o3rcwcn7' },   // повязка термо «Сиена»
  'Мешки для обуви': { hash: 'qvl2jk5bg5oxcfr8beil2y94ffgkfo7k' },       // мешок-чехол 19-001
  'Сувениры': { hash: '974723cfce167e08897efc11fb03c2a6' },              // чехлы-игрушки «Единорожки»
  // Вырезанных нет: оба раздела сняты на моделях, pick-objects их отфильтровал.
  // Пока ставим оригинал с белым фоном — заметно, что кадр чужой, но раздел
  // на месте. Вырежем, когда дойдут руки до съёмки с людьми.
  'Одежда для мальчиков': null,
  'ЕДИНЫЙ КОМАНДНЫЙ СТИЛЬ': null,
};

const NOBG = join(ROOT, '.shots', 'nobg', 'birefnet');
const IMG_OUT = join(ROOT, 'assets', 'img', 'catalog-nobg');
const RAW_OUT = join(ROOT, 'assets', 'img', 'catalog-raw');
const SITE_DIR = join(ROOT, 'old_version', 'site');

const nobgFiles = existsSync(NOBG) ? readdirSync(NOBG).filter((f) => f.endsWith('.webp')) : [];
const byHash = new Map(nobgFiles.map((f) => [f.replace(/^\d+_/, '').replace(/\.webp$/, ''), f]));

// Транслит для имён файлов: кириллица в пути доживёт до боевого сервера
// и сломается там. Та же таблица, что в pick-content.mjs.
const RU = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
const slug = (s) => s.toLowerCase().replace(/[а-яё]/g, (c) => RU[c] ?? '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 44);

// Размеры из заголовка файла, без графических зависимостей — нужны, чтобы
// выбрать у товара самый крупный кадр, а не превью 133×200.
function dim(rel) {
  try {
    const b = readFileSync(join(SITE_DIR, rel.replace(/^\//, '')));
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

mkdirSync(IMG_OUT, { recursive: true });
mkdirSync(RAW_OUT, { recursive: true });

console.log('\nКартинки разделов:');
for (const s of sections) {
  // Картинка из content/sections.json — путь к готовому файлу в assets/.
  // Её ставит админка, и она уже лежит в репозитории, поэтому ни донор,
  // ни пул .shots/nobg/ для неё не нужны. Остальные ветки ниже — прежняя
  // логика для чистой копии, где content/ ещё не собран.
  const meta = secByKey.get(s.key);
  const fromContent = meta?.img;
  if (fromContent) {
    // cut — вырезан ли фон. Кадр с фоном занимает плашку целиком и потому
    // верстается модификатором --raw; вырезанный лежит с полями.
    s.cut = Boolean(meta.cut);
    s.img = existsSync(join(ROOT, fromContent)) ? fromContent : null;
    if (!s.img) console.log(`  ⚠ ${s.title}: нет файла ${fromContent}`);
    console.log(`  из content  ${s.title.padEnd(32)} ${s.img ? basename(s.img) : '— нет кадра'}`);
    continue;
  }

  const rule = SECTION_IMG[s.name];
  s.cut = rule !== null && rule !== undefined;

  if (rule && rule.file) {
    s.img = `assets/img/catalog-nobg/${rule.file}`;
    if (!existsSync(join(IMG_OUT, rule.file))) {
      console.log(`  ⚠ ${s.title}: нет файла ${rule.file} — прогони tools/apply-nobg.mjs`);
      s.img = null;
    }
  } else if (rule && rule.hash) {
    const src = byHash.get(rule.hash);
    if (src) {
      const name = `cat-${slug(s.title)}.webp`;
      copyFileSync(join(NOBG, src), join(IMG_OUT, name));
      s.img = `assets/img/catalog-nobg/${name}`;
    } else {
      console.log(`  ⚠ ${s.title}: в пуле нет кадра ${rule.hash}`);
      s.img = null;
    }
  } else {
    // Вырезанного нет — берём самый крупный оригинал раздела как заглушку.
    let best = null, px = 0;
    for (const p of products) {
      if ((p.category || '').split('/')[0].trim() !== s.name) continue;
      for (const im of p.images || []) {
        const d = dim(im);
        if (!d) continue;
        const m = Math.min(d[0], d[1]);
        if (m > px) { px = m; best = im; }
      }
    }
    // Мельче 400px по короткой стороне брать нельзя: карточка раздела шириной
    // под 280 логических пикселей на ретине просит 560, и кадр 200×200
    // растягивается в кашу. Лучше честный пустой плейсхолдер.
    if (best && px >= 400) {
      const name = `cat-${slug(s.title)}${best.slice(best.lastIndexOf('.'))}`;
      copyFileSync(join(SITE_DIR, best.replace(/^\//, '')), join(RAW_OUT, name));
      s.img = `assets/img/catalog-raw/${name}`;
    } else {
      if (best) console.log(`  ⚠ ${s.title}: лучший оригинал всего ${px}px — ставим плейсхолдер`);
      s.img = null;
    }
  }
  console.log(`  ${s.cut ? 'вырезан ' : 'оригинал'}  ${s.title.padEnd(32)} ${s.img ? basename(s.img) : '— нет кадра'}`);
}

// --- сборка страницы ------------------------------------------------------
const home = readFileSync(join(ROOT, 'index.html'), 'utf8');

function between(html, name) {
  const a = html.indexOf(`<!-- ОБЩЕЕ:${name}:НАЧАЛО -->`);
  const b = html.indexOf(`<!-- ОБЩЕЕ:${name}:КОНЕЦ -->`);
  if (a === -1 || b === -1) throw new Error(`Нет маркеров ОБЩЕЕ:${name} в index.html`);
  return html.slice(a + `<!-- ОБЩЕЕ:${name}:НАЧАЛО -->`.length, b).trim();
}

// Страница лежит на уровень глубже, поэтому каждый относительный путь нужно
// поднять на уровень. Раньше поднимались только assets/: вся навигация в шапке
// вела на боевой axelnn.ru абсолютными ссылками. Теперь внутренние страницы
// существуют и ссылки на них относительные — без подъёма «help/» из каталога
// читалось бы как «catalog/help/» и давало 404.
// Не трогаем: протоколы, якоря, пути от корня и уже поднятые «../».
// Каждый относительный путь поднимаем на нужное число уровней. Считаем всегда
// от исходной разметки главной, а не поднимаем уже поднятое: страница раздела
// лежит на два уровня глубже (/catalog/figure-skates/), и повторное применение
// «на один уровень» её не спасало — логотип и ссылки подвала отдавали 404.
// Не трогаем: протоколы, якоря и пути от корня.
const upN = (s, n) => s.replace(
  /(src|href)="(?!https?:|mailto:|tel:|data:|#|\/)([^"]*)"/g,
  (_, attr, path) => `${attr}="${'../'.repeat(n)}${path}"`,
);

const rawHeader = between(home, 'ШАПКА');
const rawFooter = between(home, 'ПОДВАЛ');

const header = upN(rawHeader, 1);
const footer = upN(rawFooter, 1);
// Скрипт в конце главной один и тот же на всех страницах — берём его целиком.
// Закрывающий тег ищем от начала самого скрипта, а не от начала файла: в шапке
// теперь есть <script src="assets/js/shop.js">, и его </script> стоит раньше —
// поиск с нуля давал пустой срез, и на страницах молча пропадали фильтры,
// карусели и галерея.
const scriptFrom = home.indexOf('<script>');
const script = home.slice(scriptFrom, home.indexOf('</script>', scriptFrom) + '</script>'.length);

// --- шапка и подвал во все страницы --------------------------------------
// Раньше их копировал только генератор страниц каталога, а в company/, help/
// и services/ они лежали как есть и расходились с главной на первой же правке.
// Теперь во всех страницах стоят маркеры ОБЩЕЕ:*, и содержимое приезжает сюда
// из index.html — как и меню, разнесённое выше.
const HEAD_START = '<!-- ОБЩЕЕ:ШАПКА:НАЧАЛО -->', HEAD_END = '<!-- ОБЩЕЕ:ШАПКА:КОНЕЦ -->';
const FOOT_START = '<!-- ОБЩЕЕ:ПОДВАЛ:НАЧАЛО -->', FOOT_END = '<!-- ОБЩЕЕ:ПОДВАЛ:КОНЕЦ -->';

// Глубина страницы от корня: 'help/index.html' → 1, 'catalog/blades/index.html' → 2.
const depthOf = (file) => file.split('/').length - 1;

console.log('\nШапка и подвал:');
let synced = 0;
for (const file of PAGES) {
  if (file === 'index.html') continue;   // источник — правится руками
  const path = join(ROOT, file);
  const html = readFileSync(path, 'utf8');
  if (html.includes('Страницу целиком собирает')) continue;

  const depth = depthOf(file);
  let next = replaceBlock(html, HEAD_START, HEAD_END, () => upN(rawHeader, depth));
  if (next === null) { console.log(`  пропуск, нет маркеров шапки: ${file}`); continue; }
  const withFoot = replaceBlock(next, FOOT_START, FOOT_END, () => upN(rawFooter, depth));
  if (withFoot !== null) next = withFoot;

  if (next === html) continue;
  if (!DRY) writeFileSync(path, next, 'utf8');
  synced++;
  console.log(`  ${DRY ? '[dry] ' : ''}обновлено: ${file}`);
}
console.log(`  синхронизировано страниц: ${synced}`);

const cards = sections.map((s) => {
  const media = s.img
    ? `<img class="ph" src="../${s.img}" width="1000" height="1000" loading="lazy" alt="">`
    : '<span class="ph"></span>';
  return [
    `      <a href="${href(s.url)}" class="section-card">`,
    `        <div class="section-card__media${s.cut ? '' : ' section-card__media--raw'}">${media}</div>`,
    `        <div class="section-card__body">`,
    `          <span class="section-card__name">${esc(tidy(s.title))}</span>`,
    `          <span class="section-card__count">${s.total}&nbsp;${plural(s.total)}</span>`,
    `        </div>`,
    `      </a>`,
  ].join('\n');
}).join('\n');

function plural(n) {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return 'товар';
  if (d >= 2 && d <= 4 && (h < 10 || h > 20)) return 'товара';
  return 'товаров';
}

const page = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Каталог — Аксель·НН</title>
<meta name="description" content="Коньки, ботинки, лезвия, одежда, сумки и аксессуары для фигурного катания. ${visible.length} товаров в наличии, магазин в Нижнем Новгороде.">
<link rel="canonical" href="https://axelnn.ru/catalog/">
<meta name="theme-color" content="#0E7A88">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='25' font-size='26'>⛸</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600&family=Playfair+Display:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../assets/css/style.css">
</head>
<body>

<!-- Страницу целиком собирает tools/build-catalog.mjs. Руками не править:
     шапка и подвал берутся из index.html, разделы — из данных донора. -->

${header}

<section class="section container">
  <nav class="crumbs" aria-label="Хлебные крошки">
    <a href="../index.html">Главная</a>
    <span class="crumbs__sep" aria-hidden="true">/</span>
    <span class="crumbs__current" aria-current="page">Каталог</span>
  </nav>

  <div class="section__head">
    <h1 class="section-title">Каталог</h1>
    <span class="section__note">${visible.length} товаров в&nbsp;${sections.length} разделах</span>
  </div>

  <div class="section-grid">
${cards}
  </div>
</section>

${footer}

${script}

</body>
</html>
`;

const outDir = join(ROOT, 'catalog');
mkdirSync(outDir, { recursive: true });
if (!DRY) writeFileSync(join(outDir, 'index.html'), page, 'utf8');
console.log(`\n${DRY ? '[dry] ' : ''}Страница каталога: catalog/index.html (${sections.length} разделов)`);

// ==========================================================================
// Страницы разделов: /catalog/<раздел>/ со всеми товарами
// ==========================================================================

// Ключ группировки — тот же сегмент URL, что и у раздела: имена категорий
// в products.json к путям не сводятся («Хранение» против khranenie_ukhod…).
const bySection = new Map();
for (const it of visible) {
  const seg = it.url.split('/').filter(Boolean);
  if (seg[0] !== 'catalog' || !seg[1]) continue;
  if (!bySection.has(seg[1])) bySection.set(seg[1], []);
  bySection.get(seg[1]).push({ ...it, sub: seg.length >= 4 ? seg[2] : null });
}

const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function productCard(it, depth) {
  const upPath = '../'.repeat(depth);
  const media = it.img
    ? `<img class="ph" src="${upPath}${it.img}" width="900" height="900" loading="lazy" alt="${esc(it.name)}">`
    : '<span class="ph"></span>';

  // Цена размера необязательна — пустая берёт цену товара. Если у размеров
  // цены разные, честнее показать «от» самой дешёвой, а не цену товара как
  // есть: она может не соответствовать ни одному конкретному размеру.
  const sizePrices = (it.sizes || []).map((s) => s.price ?? it.price).filter((n) => n != null);
  const fromPrice = sizePrices.length ? Math.min(...sizePrices) : it.price;
  const priceVaries = sizePrices.length > 0 && new Set(sizePrices).size > 1;

  const price = fromPrice
    ? `<div class="card__prices"><span class="card__price">${priceVaries ? 'от&nbsp;' : ''}${money(fromPrice)}&nbsp;₽</span></div>`
    : '<div class="card__prices"><span class="card__price card__price--none">Цена по запросу</span></div>';
  // Фильтры работают на клиенте по этим data-атрибутам: все товары раздела уже
  // в DOM, и перерисовка сводится к переключению display у карточек.
  // Заодно это и данные для корзины — их читает assets/js/shop.js по [data-product].
  // Пути к картинке и странице там от корня: корзина рисуется на страницах
  // любой глубины, и относительный путь из раздела указывал бы в никуда.
  const data = [
    `data-sub="${esc(it.sub || '')}"`,
    `data-price="${fromPrice || 0}"`,
    it.brand ? `data-brand="${esc(it.brand)}"` : '',
    it.sizes && it.sizes.length ? `data-sizes="${esc(it.sizes.map((s) => s.size).join('|'))}"` : '',
    'data-product',
    `data-id="${esc(it.id)}"`,
    `data-name="${esc(tidy(it.name))}"`,
    `data-img="${it.img ? '/' + it.img : ''}"`,
    `data-url="${esc(it.url)}"`,
  ].filter(Boolean).join(' ');

  // Карточка больше не одна сплошная ссылка: внутри кнопки, а <button> внутри
  // <a> — невалидная вложенность. Ссылка теперь на .card__link, кнопки рядом.
  // Товар с размерами кладём в корзину без размера — уточнять его надо на
  // странице товара, где размерная сетка видна целиком.
  return [
    `        <div class="card" ${data}>`,
    `          <a href="${href(it.url)}" class="card__link">`,
    `            <div class="card__media card__media--fill">${media}</div>`,
    `            <span class="card__name">${esc(tidy(it.name))}</span>`,
    `            ${price}`,
    `          </a>`,
    `          <div class="card__actions">`,
    it.sizes && it.sizes.length
      ? `            <a class="card__buy" href="${href(it.url)}">Выбрать размер</a>`
      : `            <button type="button" class="card__buy" data-add>В корзину</button>`,
    `            <button type="button" class="card__fav" data-fav aria-pressed="false" aria-label="В избранное">`,
    `              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M12 20.5 4.4 12.9a4.6 4.6 0 0 1 6.5-6.5l1.1 1.1 1.1-1.1a4.6 4.6 0 0 1 6.5 6.5L12 20.5Z"/></svg>`,
    `            </button>`,
    `          </div>`,
    `        </div>`,
  ].join('\n');
}

// Блок фильтра. Пустые пропускаем в вызывающем коде: панель «Бренд» с одним
// пунктом ничего не отбирает и только занимает место в узкой колонке.
function filterGroup(title, name, options) {
  return [
    `        <div class="filter">`,
    `          <div class="filter__title">${esc(title)}</div>`,
    `          <div class="filter__list">`,
    ...options.map(([value, label, count]) =>
      `            <label class="filter__row"><input type="checkbox" name="${name}" value="${esc(value)}"><span class="filter__label">${esc(label)}</span><span class="filter__count">${count}</span></label>`),
    `          </div>`,
    `        </div>`,
  ].join('\n');
}

console.log('\nСтраницы разделов:');
let built = 0, noPhoto = 0;

for (const s of sections) {
  const seg = s.url.split('/').filter(Boolean)[1];
  const items = bySection.get(seg) || [];
  if (!items.length) { console.log(`  пропуск, нет товаров: ${s.title}`); continue; }

  // Заголовок подраздела берём из меню: там человеческое название, а в URL слаг.
  const subTitle = new Map(s.subs.filter((x) => x.anchor).map((x) => [x.anchor, x.title]));

  // Товары идут одной сеткой, без заголовков подразделов: отбор ушёл в фильтры
  // слева, и разбиение на группы теперь только мешало бы — при включённом
  // фильтре половина заголовков осталась бы над пустотой.
  const grid = items.map((it) => productCard(it, 2)).join('\n');

  // --- варианты фильтров считаем по товарам самого раздела ---
  const count = (pick) => {
    const m = new Map();
    for (const it of items) for (const v of pick(it)) m.set(v, (m.get(v) || 0) + 1);
    return m;
  };

  const subs = count((it) => (it.sub ? [it.sub] : []));
  const brands = count((it) => (it.brand ? [it.brand] : []));
  const sizes = count((it) => (it.sizes || []).map((s) => s.size));

  const groupsHtml = [];
  if (subs.size > 1) {
    groupsHtml.push(filterGroup('Подраздел', 'sub',
      [...subs.entries()].sort((a, b) => b[1] - a[1])
        .map(([v, n]) => [v, tidy(subTitle.get(v) || v), n])));
  }
  if (brands.size > 1) {
    groupsHtml.push(filterGroup('Бренд', 'brand',
      [...brands.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => [v, v, n])));
  }
  if (sizes.size > 1) {
    // Размеры сортируем числом, если это число: иначе «205» встаёт между
    // «20» и «21», и шкала читается как случайный набор.
    groupsHtml.push(filterGroup('Размер', 'size',
      [...sizes.entries()].sort((a, b) => {
        const na = parseFloat(a[0]), nb = parseFloat(b[0]);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a[0].localeCompare(b[0], 'ru');
      }).map(([v, n]) => [v, v, n])));
  }

  const prices = items.map((it) => it.price || 0).filter(Boolean);
  const minPrice = Math.min(...prices), maxPrice = Math.max(...prices);

  const aside = [
    // Подложка нужна только листу на телефоне: до 900px панель выезжает поверх
    // сетки, и нажатие мимо неё обязано её закрывать. На десктопе она скрыта.
    `      <div class="filters__backdrop" id="filters-backdrop" hidden></div>`,
    `      <aside class="filters" id="filters">`,
    `        <div class="filters__head">`,
    `          <span class="filters__title">Фильтры</span>`,
    `          <button type="button" class="filters__reset" id="filters-reset" hidden>Сбросить</button>`,
    `          <button type="button" class="filters__close" id="filters-close" aria-label="Закрыть фильтры">`,
    `            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>`,
    `          </button>`,
    `        </div>`,
    `        <div class="filter">`,
    `          <div class="filter__title">Цена, ₽</div>`,
    `          <div class="filter__price">`,
    `            <input type="number" class="filter__num" id="price-min" inputmode="numeric" placeholder="${minPrice}" min="${minPrice}" max="${maxPrice}" aria-label="Цена от">`,
    `            <span class="filter__dash">—</span>`,
    `            <input type="number" class="filter__num" id="price-max" inputmode="numeric" placeholder="${maxPrice}" min="${minPrice}" max="${maxPrice}" aria-label="Цена до">`,
    `          </div>`,
    `        </div>`,
    ...groupsHtml,
    // Итог отбора и выход из листа одной кнопкой. Число проставляет скрипт
    // фильтров; в разметке лежит полное количество товаров раздела — столько
    // и покажется, пока не выбрано ни одного условия.
    `        <button type="button" class="btn filters__done" id="filters-done">Показать ${items.length}&nbsp;${plural(items.length)}</button>`,
    `      </aside>`,
  ].join('\n');

  const without = items.filter((it) => !it.img).length;
  noPhoto += without;

  const sectionPage = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(tidy(s.title))} — Аксель·НН</title>
<meta name="description" content="${esc(tidy(s.title))}: ${items.length} ${plural(items.length)} для фигурного катания. Магазин в Нижнем Новгороде, доставка по России.">
<link rel="canonical" href="https://axelnn.ru${s.url}">
<meta name="theme-color" content="#0E7A88">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='25' font-size='26'>⛸</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600&family=Playfair+Display:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../../assets/css/style.css">
</head>
<body>

<!-- Страницу целиком собирает tools/build-catalog.mjs. Руками не править. -->

${upN(rawHeader, 2)}

<section class="section container">
  <nav class="crumbs" aria-label="Хлебные крошки">
    <a href="/">Главная</a>
    <span class="crumbs__sep" aria-hidden="true">/</span>
    <a href="/catalog/">Каталог</a>
    <span class="crumbs__sep" aria-hidden="true">/</span>
    <span class="crumbs__current" aria-current="page">${esc(tidy(s.title))}</span>
  </nav>

  <div class="section__head">
    <h1 class="section-title">${esc(tidy(s.title))}</h1>
    <span class="section__note" id="found" data-total="${items.length}">${items.length}&nbsp;${plural(items.length)}</span>
  </div>

  <div class="catalog-layout">
    <button type="button" class="filters__toggle" id="filters-toggle" aria-expanded="false" aria-controls="filters">
      Фильтры
      <span class="filters__toggle-count" id="filters-count" hidden>0</span>
      <svg width="12" height="8" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>
    </button>

${aside}

    <div class="catalog-main">
      <div class="cards-grid" id="grid">
${grid}
      </div>
      <p class="catalog-empty" id="empty" hidden>Под фильтры ничего не подошло. Ослабьте условия или сбросьте их.</p>
    </div>
  </div>
</section>

${upN(rawFooter, 2)}

${script}

</body>
</html>
`;

  const dir = join(outDir, seg);
  if (!DRY) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), sectionPage, 'utf8');
  }
  built++;
  console.log(`  ${String(items.length).padStart(4)} товаров  /catalog/${seg}/${without ? `   (без фото: ${without})` : ''}`);
}

console.log(`\n${DRY ? '[dry] ' : ''}Страниц разделов: ${built}, товаров без фото всего: ${noPhoto}`);

// --- убираем страницы скрытых разделов ------------------------------------
// Раздел пропал из меню и витрины, но его страница, собранная прошлым прогоном,
// осталась бы лежать на диске и открываться по прямой ссылке — с сеткой из
// плейсхолдеров. Сносим её здесь же. Файл целиком генерируемый: вернётся
// следующим прогоном, как только у товаров появятся кадры.
const liveSegs = new Set(sections.map((s) => s.url.split('/').filter(Boolean)[1]));
let dropped = 0;
for (const e of readdirSync(outDir, { withFileTypes: true })) {
  if (!e.isDirectory() || liveSegs.has(e.name)) continue;
  const file = join(outDir, e.name, 'index.html');
  if (!existsSync(file)) continue;
  // Страховка от сноса чужого файла: удаляем только то, что подписано нами.
  if (!readFileSync(file, 'utf8').includes('Страницу целиком собирает tools/build-catalog.mjs')) {
    console.log(`  оставлен, собран не нами: /catalog/${e.name}/`);
    continue;
  }
  if (!DRY) rmSync(file);
  dropped++;
  console.log(`  ${DRY ? '[dry] ' : ''}убрана страница скрытого раздела: /catalog/${e.name}/`);
}
if (dropped) console.log(`  скрытых разделов: ${dropped}`);

// ==========================================================================
// Корзина и избранное
// ==========================================================================
// Обе страницы пустые по разметке: содержимое рисует assets/js/shop.js
// из localStorage. Здесь только каркас, крошки и блок оформления.

function simplePage({ dir, title, descr, body }) {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} — Аксель·НН</title>
<meta name="description" content="${esc(descr)}">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0E7A88">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='25' font-size='26'>⛸</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600&family=Playfair+Display:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../assets/css/style.css">
</head>
<body>

<!-- Страницу целиком собирает tools/build-catalog.mjs. Руками не править. -->

${upN(rawHeader, 1)}

${body}

${upN(rawFooter, 1)}

${script}

</body>
</html>
`;
  const out = join(ROOT, dir);
  if (!DRY) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'index.html'), html, 'utf8');
  }
  console.log(`  ${DRY ? '[dry] ' : ''}/${dir}/`);
}

console.log('\nСлужебные страницы:');

simplePage({
  dir: 'cart',
  title: 'Корзина',
  descr: 'Ваша корзина в магазине Аксель·НН.',
  body: `<section class="section container">
  <nav class="crumbs" aria-label="Хлебные крошки">
    <a href="/">Главная</a>
    <span class="crumbs__sep" aria-hidden="true">/</span>
    <span class="crumbs__current" aria-current="page">Корзина</span>
  </nav>

  <div class="section__head">
    <h1 class="section-title">Корзина</h1>
    <span class="section__note" id="cart-page-count"></span>
  </div>

  <div class="cart-layout">
    <div class="cart-list" id="cart-page"></div>

    <aside class="order" id="cart-page-foot" hidden>
      <h2 class="order__title">Ваш заказ</h2>
      <div class="order__row">
        <span>Товары</span>
        <span data-cart-total>0 ₽</span>
      </div>
      <div class="order__row">
        <span>Доставка</span>
        <span>рассчитаем</span>
      </div>
      <div class="order__row order__row--total">
        <span>Итого</span>
        <span class="order__total" data-cart-total>0 ₽</span>
      </div>
      <form class="order__form" id="order-form" novalidate>
        <label class="order__field">
          <span>Имя</span>
          <input type="text" name="name" autocomplete="name">
        </label>
        <label class="order__field">
          <span>Телефон</span>
          <input type="tel" name="phone" autocomplete="tel" placeholder="+7 900 000-00-00" required>
        </label>
        <input class="order__hp" type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true">
        <button type="submit" class="btn order__btn">Отправить заказ</button>
      </form>
      <button type="button" class="btn btn--ghost order__btn" data-copy-order>Скопировать заказ</button>
      <p class="order__note">Оставьте телефон — перезвоним сами. Или позвоните
      <a href="tel:${phoneHref}">${phoneText}</a> — примем заказ, подберём размер
      и рассчитаем доставку. <a href="../help/delivery/">Условия доставки</a></p>
    </aside>
  </div>
</section>`,
});

simplePage({
  dir: 'favorites',
  title: 'Избранное',
  descr: 'Отложенные товары в магазине Аксель·НН.',
  body: `<section class="section container">
  <nav class="crumbs" aria-label="Хлебные крошки">
    <a href="/">Главная</a>
    <span class="crumbs__sep" aria-hidden="true">/</span>
    <span class="crumbs__current" aria-current="page">Избранное</span>
  </nav>

  <div class="section__head">
    <h1 class="section-title">Избранное</h1>
    <span class="section__note" id="fav-page-count"></span>
  </div>

  <div id="fav-page"></div>
</section>`,
});
