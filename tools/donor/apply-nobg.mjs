// Подставляет вырезанные кадры из .shots/nobg/ на место фото главной страницы.
//
// Связь между картинкой на сайте и её вырезанной версией не выводится из имени файла:
// в assets/img/catalog/ лежит человекочитаемый слаг (item-chehly-na-lezviya-edea.jpg),
// а remove-bg.mjs называет результат по хэшу исходника из /upload/iblock/.
// Мост между ними — tools/donor/content.json: там у каждого товара есть и `img` (путь
// в доноре), и `local` (файл в assets). По `img` и находим кадр в отчёте remove-bg.
//
// Оригиналы не трогаем: вырезанные PNG кладутся рядом, в catalog-nobg/, чтобы
// можно было сравнить и откатиться. Ссылки в index.html правит --html.
//
//   node tools/apply-nobg.mjs           скопировать вырезанные в catalog-nobg/
//   node tools/apply-nobg.mjs --html    ещё и переписать пути в index.html
import { readFileSync, writeFileSync, copyFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('../..');
const NOBG = join(ROOT, '.shots', 'nobg', 'birefnet');
const OUT = join(ROOT, 'assets', 'img', 'catalog-nobg');

const HTML = process.argv.includes('--html');

const content = JSON.parse(readFileSync(new URL('content.json', import.meta.url), 'utf8'));
const report = JSON.parse(readFileSync(join(NOBG, '_report.json'), 'utf8'));

// Отчёт покрывает пакетный прогон. Одиночные кадры (`--file`) в него не попадают:
// каждый такой запуск переписывает _report.json своим единственным товаром, поэтому
// их ищем прямо по файлам — имя вырезанного всегда содержит хэш исходника.
const bySrc = new Map(report.items.filter((i) => i.file).map((i) => [i.src, i.file]));
const onDisk = readdirSync(NOBG).filter((f) => f.endsWith('.webp'));
const byHash = new Map(onDisk.map((f) => [f.replace(/^\d+_/, '').replace(/\.webp$/, ''), f]));

const cut = (src) => bySrc.get(src) ?? byHash.get(basename(src).replace(/\.[^.]+$/, ''));

// Ручные подмены кадров для кружков категорий.
//
// pick-content.mjs выбирает картинку раздела по одному критерию — самое крупное
// чистое фото. Для карточек товара этого хватает, а для категории кадр должен
// ещё и объяснять раздел с одного взгляда. Три автоматических выбора этого не
// делали, поэтому здесь они переопределены вручную. Ключ — имя файла, которое
// назначил pick-content.mjs; hash — исходник вырезанного кадра в .shots/nobg/.
const OVERRIDE = {
  // Автовыбор — доска для вращения: на фото она свёрнута и читается как чёрная
  // повязка с принтом, а не как снаряд. Диск узнаётся сразу и круглой формой
  // ложится в круглый кружок категории.
  'cat-doska-dlya-otrabotki-vrascheniya-figure-skat.jpg': {
    hash: '3dq7tvzdxy4fkztoigxzt1d4lex1ybcd',
    name: 'cat-spinner-disk-panda.webp',
  },
  // Автовыбор — сушки для обуви: на светлой ткани проступает водяной знак
  // поставщика «Studio Sports». На чёрном термочехле того же раздела его нет.
  'cat-sushki-dlya-obuvi-012.jpg': {
    hash: 'o5feg1ktnctl9rv19yteca6xx0ktqe5v',
    name: 'cat-termochehly-na-botinok-chernye.webp',
  },
  // Весь раздел одежды снят на моделях. Предметных кадров на белом — шесть, и
  // пять из них колготки; выбираем тот, где ноги в коньках, а не босиком.
  // Срез по бедру убирает CSS: .category__media--bleed-top уводит его за верх круга.
  'cat-dlya-vystupleniy-kolgotki-art-1155-v-botinok.jpg': {
    hash: 'fhj0y37lg6qg6r70s7677ygtszi3pz6k',
    name: 'cat-kolgotki-so-strazami-art-1152.webp',
  },
};

// Кадры промо-карусели. Здесь content.json не помощник: он знает по одной
// картинке на раздел, а кружки категорий эти картинки уже заняли. Слайд промо
// крупный, и повтор того же кадра в двух местах страницы бросается в глаза,
// поэтому шесть кадров подобраны отдельно — из тех же 336, но других товаров.
// Лезвия исключение: чистый кадр в разделе ровно один, остальные с текстом
// прямо в фотографии, так что здесь повтор с кружком осознанный.
const PROMO = {
  'promo-botinki-edea-overture.webp': '59ece31e58be7644751dc68a8bb63654',
  'promo-konki-jackson-elle.webp': 'nhozg47slz3uw2rljrbjf3auopip965g',
  'promo-lezviya-mk-professional.webp': '93d146e8c88047f7b373fc5986aa2c23',
  'promo-ryukzak-runa-zimniy-sad.webp': '446548b41e110d2ee0f9199a537b7b9b',
  'promo-meshok-chehol-19-006.webp': '4moddnoqayipmk3m1fpj37xgj8o9cg7p',
  'promo-spinner-winter-fantasy.webp': '61a77240477a73f97ce9608cbe851cc3',
};

const entries = [
  ...content.showcase.map((p) => ['витрина', p]),
  ...content.care.map((p) => ['уход', p]),
  ...Object.entries(content.categories).map(([c, p]) => [`раздел: ${c}`, p]),
];

mkdirSync(OUT, { recursive: true });

const swaps = new Map();   // старый путь -> новый
const missing = [];

for (const [group, p] of entries) {
  const ov = OVERRIDE[basename(p.local)];
  const file = ov ? byHash.get(ov.hash) : cut(p.img);
  if (!file) { missing.push([group, p.name, ov ? ov.hash : p.img]); continue; }

  // Без подмены имя оставляем прежнее, меняется только расширение: так diff
  // в index.html остаётся читаемым, а файл опознаётся по названию товара.
  const name = ov ? ov.name : basename(p.local).replace(/\.[^.]+$/, '.webp');
  copyFileSync(join(NOBG, file), join(OUT, name));
  // Второй ключ — путь, который скрипт проставил в прошлый прогон. Без него
  // повторный запуск с подменой ничего не найдёт: в разметке уже не catalog/,
  // а catalog-nobg/, и старое имя из content.json там больше не встречается.
  swaps.set(p.local, `assets/img/catalog-nobg/${name}`);
  const prev = `assets/img/catalog-nobg/${basename(p.local).replace(/\.[^.]+$/, '.webp')}`;
  if (prev !== `assets/img/catalog-nobg/${name}`) swaps.set(prev, `assets/img/catalog-nobg/${name}`);
  console.log(`  ${group.padEnd(30)} ${name}${ov ? '   (подмена)' : ''}`);
}

for (const [name, hash] of Object.entries(PROMO)) {
  const file = byHash.get(hash);
  if (!file) { missing.push(['промо', name, hash]); continue; }
  copyFileSync(join(NOBG, file), join(OUT, name));
  console.log(`  ${'промо'.padEnd(30)} ${name}`);
}

console.log(`\nСкопировано: ${swaps.size} → assets/img/catalog-nobg/`);
if (missing.length) {
  console.log(`\nНет вырезанной версии (${missing.length}):`);
  for (const [g, n, img] of missing) console.log(`  ${g.padEnd(30)} ${n.slice(0, 40)}  ${img}`);
}

if (!HTML) { console.log('\nБез --html: index.html не тронут'); process.exit(0); }

// --- правка разметки ---
const file = join(ROOT, 'index.html');
let html = readFileSync(file, 'utf8');
let n = 0;

for (const [from, to] of swaps) {
  if (!html.includes(from)) continue;
  // Вырезанные кадры — квадрат 1000×1000 (см. --size в remove-bg.mjs). Оставить
  // старые width/height нельзя: браузер зарезервирует место под чужие пропорции
  // и вёрстка дёрнется при загрузке.
  html = html.replace(
    new RegExp(`src="${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"([^>]*?)width="\\d+" height="\\d+"`, 'g'),
    `src="${to}"$1width="1000" height="1000"`,
  );
  html = html.split(from).join(to);
  n++;
}

writeFileSync(file, html, 'utf8');
console.log(`\nindex.html: заменено путей — ${n}`);
