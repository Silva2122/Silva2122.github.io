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
// Источники: old_version/categories.json (URL и заголовки разделов),
// old_version/products.json (сколько товаров реально лежит в разделе).
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');
const DRY = process.argv.includes('--dry');

const { categories } = JSON.parse(readFileSync(join(ROOT, 'old_version', 'categories.json'), 'utf8'));
const { products } = JSON.parse(readFileSync(join(ROOT, 'old_version', 'products.json'), 'utf8'));

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
const tree = new Map();
for (const p of products) {
  const [top, sub] = (p.category || '').split('/').map((s) => s.trim());
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

const sections = [...tree.entries()]
  .sort((a, b) => {
    const ia = ORDER.indexOf(a[0]), ib = ORDER.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  })
  .map(([name, node]) => {
    const seg = topPath(node.paths);
    const url = seg ? `/catalog/${seg}/` : topUrl(name);
    return {
      name,
      title: TITLES[name] || name,
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
  .filter((s) => s.url);   // без адреса ссылку не построить

console.log(`Разделов: ${sections.length}, товаров: ${products.length}`);
for (const s of sections) {
  console.log(`  ${String(s.total).padStart(4)}  ${s.title.padEnd(32)} ${s.subs.length} подразделов`);
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

function inject(file) {
  const path = join(ROOT, file);
  if (!existsSync(path)) { console.log(`  пропуск, нет файла: ${file}`); return; }
  const html = readFileSync(path, 'utf8');
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from === -1 || to === -1) { console.log(`  пропуск, нет маркеров: ${file}`); return; }

  // Отступ маркера задаёт отступ вставки — иначе сгенерированный блок
  // выпадает из форматирования файла и diff становится нечитаемым.
  const lineStart = html.lastIndexOf('\n', from) + 1;
  const indent = from - lineStart;

  const next = html.slice(0, from + START.length) + '\n' + menuMarkup(indent) + '\n' + ' '.repeat(indent) + html.slice(to);
  if (next === html) { console.log(`  без изменений: ${file}`); return; }
  if (!DRY) writeFileSync(path, next, 'utf8');
  console.log(`  ${DRY ? '[dry] ' : ''}меню обновлено: ${file}`);
}

// Шапка одинакова на всех страницах, а меню каталога в ней — сгенерированное.
// Правка в одном файле без остальных разошлась бы с ними на первой же правке
// данных, поэтому обходим все страницы сайта. Список не держим руками: страниц
// разделов пятнадцать, и они сами появляются ниже в этом же прогоне — ручной
// перечень отстал бы от них на один запуск.
function pages(dir = ROOT, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'old_version' || e.name === 'tools') continue;
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
const script = home.slice(home.indexOf('<script>'), home.indexOf('</script>') + '</script>'.length);

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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Каталог — Аксель·НН</title>
<meta name="description" content="Коньки, ботинки, лезвия, одежда, сумки и аксессуары для фигурного катания. ${products.length} товаров в наличии, магазин в Нижнем Новгороде.">
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
    <span class="section__note">${products.length} товаров в&nbsp;${sections.length} разделах</span>
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

// Манифест готовит tools/prepare-product-images.mjs: он же ужимает кадры
// и решает, какому товару достался вырезанный фон, а какому оригинал.
const MANIFEST = join(ROOT, 'assets', 'products.json');
if (!existsSync(MANIFEST)) {
  console.log('\nНет assets/products.json — сначала прогони tools/prepare-product-images.mjs');
  process.exit(0);
}
const catalogItems = JSON.parse(readFileSync(MANIFEST, 'utf8'));

// Ключ группировки — тот же сегмент URL, что и у раздела: имена категорий
// в products.json к путям не сводятся («Хранение» против khranenie_ukhod…).
const bySection = new Map();
for (const it of catalogItems) {
  const seg = it.url.split('/').filter(Boolean);
  if (seg[0] !== 'catalog' || !seg[1]) continue;
  if (!bySection.has(seg[1])) bySection.set(seg[1], []);
  bySection.get(seg[1]).push({ ...it, sub: seg.length >= 4 ? seg[2] : null });
}

const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function productCard(it, depth) {
  const upPath = '../'.repeat(depth);
  const media = it.img
    ? `<img class="ph" src="${upPath}${it.img}" width="600" height="600" loading="lazy" alt="${esc(it.name)}">`
    : '<span class="ph"></span>';
  const price = it.price
    ? `<div class="card__prices"><span class="card__price">${money(it.price)}&nbsp;₽</span></div>`
    : '<div class="card__prices"><span class="card__price card__price--none">Цена по запросу</span></div>';
  // Карточка ведёт на боевой сайт: страниц товара у нас ещё нет, а внутренняя
  // ссылка отдавала бы 404 на каждый клик. Как появятся — заменить на href(it.url).
  return [
    `        <a href="${SITE}${it.url}" class="card">`,
    `          <div class="card__media">${media}</div>`,
    `          <span class="card__name">${esc(tidy(it.name))}</span>`,
    `          ${price}`,
    `        </a>`,
  ].join('\n');
}

console.log('\nСтраницы разделов:');
let built = 0, noPhoto = 0;

for (const s of sections) {
  const seg = s.url.split('/').filter(Boolean)[1];
  const items = bySection.get(seg) || [];
  if (!items.length) { console.log(`  пропуск, нет товаров: ${s.title}`); continue; }

  // Группируем по подразделам. Товары, лежащие прямо в разделе, идут первыми
  // без заголовка — отдельная плашка «Разное» ради них только мусорила бы.
  const groups = new Map();
  const loose = [];
  for (const it of items) {
    if (!it.sub) { loose.push(it); continue; }
    if (!groups.has(it.sub)) groups.set(it.sub, []);
    groups.get(it.sub).push(it);
  }

  // Заголовок подраздела берём из меню: там человеческое название, а в URL слаг.
  const subTitle = new Map(s.subs.filter((x) => x.anchor).map((x) => [x.anchor, x.title]));

  const chips = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([sub, list]) =>
      `      <a class="chip" href="#${sub}">${esc(tidy(subTitle.get(sub) || sub))}<span class="chip__count">${list.length}</span></a>`)
    .join('\n');

  const blocks = [];
  if (loose.length) {
    blocks.push(`    <div class="cards-grid">\n${loose.map((it) => productCard(it, 2)).join('\n')}\n    </div>`);
  }
  for (const [sub, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    blocks.push([
      `    <div class="subsection" id="${sub}">`,
      `      <h2 class="subsection__title">${esc(tidy(subTitle.get(sub) || sub))}<span class="subsection__count">${list.length}</span></h2>`,
      `      <div class="cards-grid">`,
      list.map((it) => productCard(it, 2)).join('\n'),
      `      </div>`,
      `    </div>`,
    ].join('\n'));
  }

  const without = items.filter((it) => !it.img).length;
  noPhoto += without;

  const sectionPage = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
    <span class="section__note">${items.length}&nbsp;${plural(items.length)}</span>
  </div>
${chips ? `\n    <div class="chips">\n${chips}\n    </div>\n` : ''}
${blocks.join('\n\n')}
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
