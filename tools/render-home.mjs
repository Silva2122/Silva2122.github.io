// Пересобирает ленты и сетку категорий в index.html из assets/content.json.
// Здесь же живёт редакторская чистка названий: в базе Bitrix они сырые —
// «Лезвия для конков MK Professional», «Фигурные коньки Edea OVERTURE SET ROTATION»,
// «Сушка на лезвия(сушка) котик». В премиальную вёрстку так ставить нельзя.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');

const data = JSON.parse(readFileSync(join(ROOT, 'assets', 'content.json'), 'utf8'));

const TYPOS = {
  'конков': 'коньков', 'Термо ': 'Термо', 'колесах': 'колёсах', 'колесиках': 'колёсиках',
  'Медвеженок': 'Медвежонок',
};

// Названия, которые правилами не вычистить: в базе перепутан порядок слов или
// тип товара продублирован. Ключ — узнаваемый кусок исходного названия.
const OVERRIDES = [
  ['Спиннер-диск', 'Спиннер-диск «Смайлики»'],
  ['(сушка) котик', 'Сушка на лезвия «Котик»'],
  ['пудель розовый', 'Сушка на лезвия «Пудель»'],
  ['Капибара восхождение', 'Сумка-рюкзак «Cube» Капибара'],
  ['Зверята', 'Сушка на лезвия «Медвежонок»'],
];

function cleanName(s) {
  for (const [needle, replacement] of OVERRIDES) {
    if (s.includes(needle)) return replacement;
  }
  let n = s.trim();
  for (const [from, to] of Object.entries(TYPOS)) n = n.replaceAll(from, to);

  // Скобка, повторяющая уже сказанное: «Сушка на лезвия (сушка) котик»
  n = n.replace(/\s*\(([^)]+)\)/g, (m, inner) => {
    const stem = inner.trim().toLowerCase().slice(0, 5);
    const rest = n.replace(m, '').toLowerCase();
    return stem.length >= 4 && rest.includes(stem) ? '' : m;
  });

  n = n.replace(/\s+-\s+/g, ' — ');        // дефис между словами это тире

  n = n.replace(/\s{2,}/g, ' ');           // двойные пробелы
  n = n.replace(/\s*\(\s*/g, ' (').replace(/\s*\)/g, ')');
  n = n.replace(/"([^"]*)"/g, '«$1»');     // прямые кавычки в ёлочки
  n = n.replace(/([а-яa-z])\(/gi, '$1 ('); // «лезвия(сушка)» -> «лезвия (сушка)»

  // ЗАГЛАВНЫЕ слова -> обычный регистр. В названиях моделей это крик,
  // а не выделение: OVERTURE SET ROTATION -> Overture Set Rotation.
  n = n.replace(/\b[A-ZА-Я]{3,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());

  // хвостовые артикулы и служебные пометки
  n = n.replace(/\s*\*+\s*$/, '').replace(/\s+\d{1,2}\s*$/, '');
  n = n.replace(/\s*,\s*/g, ', ');
  return n.trim();
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '&nbsp;₽';
// неразрывный после коротких предлогов — иначе они виснут в конце строки
const nb = (s) => s.replace(/ (на|в|с|и|для|по|от|до|за|под|из|к|о) /g, ' $1&nbsp;');

const card = (p) => {
  const n = cleanName(p.name);
  const [w, h] = p.size.split('×');
  return `      <a href="https://axelnn.ru${p.url}" class="card">
        <div class="card__media"><img class="ph" src="${p.local}" width="${w}" height="${h}" loading="lazy" alt="${esc(n)}"></div>
        <span class="card__name">${nb(esc(n))}</span>
        <div class="card__prices"><span class="card__price">${money(p.price)}</span></div>
      </a>`;
};

const CAT = {
  'Фигурные коньки':                { url: 'figure-skates', name: 'Фигурные коньки' },
  'Ботинки для фигурного катания':  { url: 'botinki_dlya_figurnogo_kataniya', name: 'Ботинки' },
  'Лезвия':                         { url: 'blades', name: 'Лезвия' },
  'Одежда для девочек':             { url: 'odezhda_dlya_devochek', name: 'Одежда' },
  'Защита фигуриста':               { url: 'zashchita_figurista_', name: 'Защита' },
  'Хранение':                       { url: 'khranenie_ukhod_za_konkami', name: 'Хранение и уход' },
  'Сумки,рюкзаки':                  { url: 'sumki_ryukzaki', name: 'Сумки и рюкзаки' },
  'Тренажеры':                      { url: 'trenazhery_', name: 'Тренажёры' },
  'Сувениры':                       { url: 'suveniry', name: 'Сувениры' },
};
const ORDER = Object.keys(CAT);

const cats = ORDER.filter((c) => data.categories[c]).map((c) => {
  const p = data.categories[c];
  const [w, h] = p.size.split('×');
  return `    <a href="https://axelnn.ru/catalog/${CAT[c].url}/" class="category">
      <div class="category__media"><img class="ph" src="${p.local}" width="${w}" height="${h}" loading="lazy" alt=""></div>
      <div class="category__name">${CAT[c].name}</div>
    </a>`;
});

// --- подстановка ---
const file = join(ROOT, 'index.html');
let html = readFileSync(file, 'utf8');

const tracks = [...html.matchAll(/(<div class="carousel__track cx-scroll">)([\s\S]*?)(\n    <\/div>)/g)];
if (tracks.length !== 2) throw new Error(`Ожидались две ленты, найдено: ${tracks.length}`);
html = html.replace(tracks[0][0], tracks[0][1] + '\n' + data.showcase.map(card).join('\n') + tracks[0][3]);
html = html.replace(tracks[1][0], tracks[1][1] + '\n' + data.care.map(card).join('\n') + tracks[1][3]);

const grid = html.match(/(<div class="categories__grid">)([\s\S]*?)(\n  <\/div>)/);
if (!grid) throw new Error('Сетка категорий не найдена');
html = html.replace(grid[0], grid[1] + '\n' + cats.join('\n') + grid[3]);

writeFileSync(file, html, 'utf8');
console.log(`Витрина: ${data.showcase.length}, вторая лента: ${data.care.length}, категорий: ${cats.length}`);
console.log('\nНазвания после чистки:');
for (const p of [...data.showcase, ...data.care]) console.log(`  ${cleanName(p.name)}`);
