// Разовый перенос данных из донора в content/ — редактируемый слой сайта.
//
//   node tools/migrate-content.mjs          собрать content/ из донора
//   node tools/migrate-content.mjs --force  перезаписать уже собранное
//
// До админки данные жили в двух местах, которых нет в репозитории:
// assets/products.json собирался из зеркала старого сайта, а описания брались
// прямо из old_version/products.json на 90 МБ. Редактировать это владельцу
// нечем и негде. Здесь всё нужное вынимается один раз и ложится в content/,
// после чего донор для сборки сайта больше не нужен.
//
// Скрипт ничего не выдумывает: цены, кадры и размеры берутся из манифеста
// как есть, описания — из донора с той же чисткой, что делал build-products,
// разделы — из уже собранной витрины /catalog/, где стоят реальные картинки.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, paths, readJSON, writeJSON, hasContent, segments } from './content.mjs';

const FORCE = process.argv.includes('--force');

if (hasContent() && !FORCE) {
  console.error('content/products.json уже есть. Перезаписать — с флагом --force');
  process.exit(1);
}

// --- товары ---------------------------------------------------------------

const manifest = readJSON(paths.manifest);
if (!manifest) {
  console.error('Нет assets/products.json — сначала tools/prepare-product-images.mjs');
  process.exit(1);
}

const donorFile = join(ROOT, 'old_version', 'products.json');
const donor = existsSync(donorFile)
  ? JSON.parse(readFileSync(donorFile, 'utf8')).products
  : [];

if (!donor.length) console.log('⚠ Донора нет — товары переносятся без описаний');

const byId = new Map(donor.map((p) => [String(p.id), p]));

// В доноре description — весь текстовый слой детальной страницы Aspro: после
// самого описания идут форма отзыва, форма вопроса и хвост «быстрого просмотра»
// соседних товаров. Режем по первому же их маркеру. Та же чистка, что стояла
// в build-products.mjs, — теперь она делается один раз здесь, а не на каждой
// сборке, и результат владелец правит руками.
const JUNK = /(Отзывы|Оставить отзыв|Задать вопрос|Быстрый просмотр|Перетащите файлы|Ничего не найдено|Характеристики товара)/;

function description(p) {
  let text = (p.description || '').replace(/\r/g, '');
  const hit = text.match(JUNK);
  if (hit) text = text.slice(0, hit.index);
  return text
    .split('\n')
    .map((s) => s.trim())
    // «Все товары можете посмотреть в нашем Каталоге» — ссылка из шаблона
    // поставщика, приклеенная к концу описания. Каталог у нас в шапке.
    .map((s) => s.replace(/\s*Все товары можете посмотреть.*$/i, '').trim())
    .filter(Boolean)
    .filter((s) => s.length > 1);
}

const products = manifest.map((it) => ({
  id: String(it.id),
  name: it.name,
  price: it.price ?? null,
  oldPrice: it.oldPrice ?? null,
  available: it.available !== false,
  cat: it.cat || '',
  url: it.url,
  brand: it.brand || null,
  sizes: it.sizes || [],
  description: description(byId.get(String(it.id)) || {}),
  img: it.img || null,
  gallery: it.gallery || [],
  cut: Boolean(it.cut),
  // Скрытие руками. Товар без фото прячется и без него — по общему правилу
  // из visible.mjs, — а этот флаг для случая «есть на сайте, но продавать
  // сейчас нечего»: данные остаются, карточка уходит.
  hidden: false,
}));

writeJSON(paths.products, products);

const withDescr = products.filter((p) => p.description.length).length;
const withPhoto = products.filter((p) => p.img).length;
console.log(`content/products.json: ${products.length} товаров, ${withPhoto} с фото, ${withDescr} с описанием`);

// --- разделы --------------------------------------------------------------
// Заголовок, порядок и картинку берём из уже собранной витрины /catalog/:
// там стоит ровно то, что видит посетитель, и картинки лежат в assets/,
// а не в .shots/ и не в зеркале. После переноса build-catalog.mjs читает
// эту таблицу вместо зашитых в него ORDER / TITLES / SECTION_IMG.

const showcase = join(ROOT, 'catalog', 'index.html');
const html = existsSync(showcase) ? readFileSync(showcase, 'utf8') : '';

// <a href="/catalog/<key>/" class="section-card"> … <img src="../assets/…"> …
// <span class="section-card__name">Заголовок</span>
const CARD = /<a href="\/catalog\/([^"/]+)\/" class="section-card">([\s\S]*?)<\/a>/g;
const fromShowcase = new Map();
for (const [, key, body] of html.matchAll(CARD)) {
  const img = body.match(/<img[^>]+src="\.\.\/([^"]+)"/)?.[1] || null;
  const title = body.match(/class="section-card__name">([^<]+)</)?.[1]?.trim() || null;
  fromShowcase.set(decodeURIComponent(key), { img, title });
}

// Имя категории у товара («Хранение») и заголовок раздела на витрине
// («Хранение и уход») — разные строки. Связываем их через сегмент URL:
// он один и тот же и в адресе товара, и в адресе страницы раздела.
const order = [...fromShowcase.keys()];
const byKey = new Map();

for (const p of products) {
  const { top } = segments(p.url);
  if (!top) continue;
  const name = (p.cat || '').split('/')[0].trim();
  if (!byKey.has(top)) byKey.set(top, { key: top, names: new Map(), count: 0 });
  const node = byKey.get(top);
  node.count++;
  if (name) node.names.set(name, (node.names.get(name) || 0) + 1);
}

const sections = [...byKey.values()]
  .map((node) => {
    const shown = fromShowcase.get(node.key) || {};
    // У раздела может встретиться несколько написаний имени категории —
    // берём то, что встречается чаще.
    const name = [...node.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || node.key;
    return {
      key: node.key,
      name,
      title: shown.title || name,
      img: shown.img || null,
      // Вырезан ли фон у кадра. Кадр с фоном верстается иначе (он прямоугольный
      // и упирается в края плашки), поэтому карточка получает модификатор
      // --raw. Признак виден по папке: catalog-nobg/ против catalog-raw/.
      cut: Boolean(shown.img && shown.img.includes('/catalog-nobg/')),
      hidden: false,
      count: node.count,
    };
  })
  .sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  })
  .map(({ count, ...s }, i) => ({ ...s, order: i }));

writeJSON(paths.sections, sections);
console.log(`content/sections.json: ${sections.length} разделов`);

// --- контакты -------------------------------------------------------------
// Телефон, почта и соцсети повторяются в шапке, подвале и на «Контактах».
// Собираем их из главной — она источник шапки и подвала для всего сайта.

const home = readFileSync(join(ROOT, 'index.html'), 'utf8');
const contacts = existsSync(join(ROOT, 'contacts', 'index.html'))
  ? readFileSync(join(ROOT, 'contacts', 'index.html'), 'utf8')
  : '';

const social = [...(home.match(/<div class="footer__social">[\s\S]*?<\/div>/)?.[0] || '')
  .matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

const site = {
  phone: home.match(/class="header__phone">([^<]+)</)?.[1]?.trim() || '',
  email: contacts.match(/href="mailto:([^"]+)"/)?.[1] || home.match(/href="mailto:([^"]+)"/)?.[1] || '',
  vk: social[0] || '',
  telegram: social[1] || '',
};

writeJSON(paths.site, site);
console.log(`content/site.json: телефон ${site.phone || '—'}, почта ${site.email || '—'}`);
for (const s of sections) {
  console.log(`  ${String(s.order).padStart(2)}  ${s.title.padEnd(32)} ${s.img ? '' : '— нет картинки'}`);
}
