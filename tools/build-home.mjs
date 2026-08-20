// Подборки товаров на главной — карусели «Новинки» и «Скидки и акции».
// Раньше их состав был вписан в index.html руками; теперь список артикулов
// в content/home.json (правит админка), а карточки собирает этот скрипт —
// той же карточкой, что и лента похожих на странице товара (card__media--fill,
// цена «от», если у размеров она разная).
//
//   node tools/build-home.mjs          применить
//   node tools/build-home.mjs --dry    показать, ничего не записывая
//
// Заголовки блоков («Новинки», «Скидки и акции») — обычный текстовый слот,
// его правят в «Текстах страниц» (tools/pages.mjs подхватывает
// <h2 class="section-title">) — здесь только состав и порядок карточек.
//
// Кадры без фона (assets/img/catalog-nobg/), которыми были собраны исходные
// карточки, — заслуга разового прохода donor/apply-nobg.mjs по конкретным
// шести-восьми товарам, а не общее свойство каталога: у произвольного
// товара, который владелец впишет в подборку, такого кадра не будет никогда.
// Поэтому здесь всегда обычное фото товара (p.img) — то же самое, что видно
// в каталоге и в ленте похожих, а не специальный вырезанный кадр.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadHome, loadProducts, HOME_COLLECTIONS } from './content.mjs';
import { isVisible } from './visible.mjs';

const DRY = process.argv.includes('--dry');
const INDEX = join(ROOT, 'index.html');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tidy = (s) => s.replace(/,(?=\S)/g, ', ').replace(/\s+/g, ' ').replace(/\s*\.\s*$/, '').trim();
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function card(it) {
  const media = it.img
    ? `<img class="ph" src="${esc(it.img)}" width="600" height="600" loading="lazy" alt="${esc(tidy(it.name))}">`
    : '<span class="ph"></span>';

  // Та же арифметика «от», что у карточки раздела: если у размеров цены
  // разные, честнее показать минимальную с пометкой, чем цену товара как есть.
  const sizePrices = (it.sizes || []).map((s) => s.price ?? it.price).filter((n) => n != null);
  const fromPrice = sizePrices.length ? Math.min(...sizePrices) : it.price;
  const priceVaries = sizePrices.length > 0 && new Set(sizePrices).size > 1;
  const price = fromPrice
    ? `<span class="card__price">${priceVaries ? 'от&nbsp;' : ''}${money(fromPrice)}&nbsp;₽</span>`
    : '<span class="card__price card__price--none">Цена по запросу</span>';

  // Без своего отступа: replaceBlock добавляет отступ маркера ко всем
  // строкам разом, свой здесь наложился бы поверх и удвоился.
  return [
    `<a href="${esc(it.url)}" class="card">`,
    `  <div class="card__media card__media--fill">${media}</div>`,
    `  <span class="card__name">${esc(tidy(it.name))}</span>`,
    `  <div class="card__prices">${price}</div>`,
    '</a>',
  ].join('\n');
}

function replaceBlock(html, key, build) {
  const start = `<!-- ГЛАВНАЯ:ПОДБОРКА:${key}:НАЧАЛО -->`;
  const end = `<!-- ГЛАВНАЯ:ПОДБОРКА:${key}:КОНЕЦ -->`;
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from === -1 || to === -1) {
    console.log(`  ⚠ нет маркеров для «${key}» в index.html — блок пропущен`);
    return html;
  }

  const lineStart = html.lastIndexOf('\n', from) + 1;
  const indent = ' '.repeat(from - lineStart);
  const body = build().split('\n').map((l) => (l ? indent + l : l)).join('\n');

  return html.slice(0, from + start.length) + '\n' + body + '\n' + indent + html.slice(to);
}

const home = loadHome();
const products = loadProducts();
const byId = new Map(products.map((p) => [String(p.id), p]));

let html = readFileSync(INDEX, 'utf8');

for (const { key, title } of HOME_COLLECTIONS) {
  const ids = home[key] || [];
  const items = [];
  for (const id of ids) {
    const p = byId.get(String(id));
    if (!p) { console.log(`  ⚠ «${title}»: товара ${id} больше нет — убран из подборки`); continue; }
    if (!isVisible(p)) { console.log(`  ⚠ «${title}»: товар ${id} (${p.name}) скрыт — убран из подборки`); continue; }
    items.push(p);
  }

  html = replaceBlock(html, key, () => (
    items.length ? items.map(card).join('\n') : '<!-- пока пусто: добавьте товары в админке -->'
  ));
  console.log(`  ${title}: ${items.length} ${items.length === 1 ? 'товар' : 'товаров'}`);
}

if (!DRY) writeFileSync(INDEX, html, 'utf8');
console.log(`\n${DRY ? '[dry] ' : ''}Подборки на главной обновлены в index.html`);
