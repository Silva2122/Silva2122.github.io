// Редактируемый слой контента: всё, что правит владелец сайта через админку.
//
// До него источником данных был донор — old_version/products.json на 90 МБ,
// которого нет ни в репозитории, ни на хостинге. Пока сайт собирали руками,
// это работало; админке нужен источник, который лежит рядом с сайтом, правится
// и коммитится. Отсюда content/:
//
//   content/products.json   товары: цены, наличие, описания, фото, скрытие
//   content/sections.json   разделы каталога: заголовок, порядок, картинка
//   content/site.json       телефон, адрес, часы, соцсети — на весь сайт
//   content/home.json       главная: герой, бегущая строка, промо, подборки
//   content/pages.json      тексты внутренних страниц
//
// Донор остаётся донором: из него один раз вынимает данные migrate-content.mjs,
// дальше он не нужен. Генераторы читают content/, а если его ещё нет —
// откатываются на старые источники, чтобы сборка не падала на чистой копии.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Путь из import.meta.url на Windows приезжает как /C:/... — срезаем слэш.
// Тот же хелпер, что в остальных скриптах tools/.
const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export const ROOT = base('..');
export const CONTENT = join(ROOT, 'content');

export const paths = {
  products: join(CONTENT, 'products.json'),
  sections: join(CONTENT, 'sections.json'),
  site: join(CONTENT, 'site.json'),
  home: join(CONTENT, 'home.json'),
  pages: join(CONTENT, 'pages.json'),
  manifest: join(ROOT, 'assets', 'products.json'),
};

// --- чтение и запись ------------------------------------------------------

export function readJSON(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Битый JSON: ${file}\n${e.message}`);
  }
}

// Пишем через временный файл: админка сохраняет по кнопке, и обрыв записи
// посреди двухмегабайтного products.json оставил бы сайт без каталога вовсе.
// rename в пределах одного тома атомарен — читатель видит либо старый файл,
// либо новый целиком.
// Отступ — ради истории правок: content/ лежит в репозитории, и в дифе после
// смены цены должно быть видно одну строку, а не переписанный целиком файл.
// Манифест — машинный, его читают только генераторы, и печатать его в строчку
// дешевле: полтора мегабайта отступов в каждом коммите никому не нужны.
export function writeJSON(file, data, pretty = true) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, pretty ? 1 : 0) + '\n', 'utf8');
  renameSync(tmp, file);
}

export const hasContent = () => existsSync(paths.products);

// --- товары ---------------------------------------------------------------

export const loadProducts = () => readJSON(paths.products, []);
export const saveProducts = (list) => writeJSON(paths.products, list);

// Манифест assets/products.json остаётся тем же, что писал
// prepare-product-images.mjs: его читают оба генератора, и менять их формат
// ради админки незачем. Здесь он становится производной от content/ —
// скрытые товары в него не попадают вовсе.
//
// Скрытый раздел уносит с собой и товары: иначе они пропали бы из меню
// и с витрины, но собственные страницы получили бы и открывались по прямой
// ссылке — с хлебными крошками в раздел, которого на сайте больше нет.
export function toManifest(products, sections = loadSections()) {
  const closed = new Set(sections.filter((s) => s.hidden).map((s) => s.key));
  return products
    .filter((p) => !p.hidden && !closed.has(segments(p.url).top))
    .map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price ?? null,
      oldPrice: p.oldPrice ?? null,
      available: p.available !== false,
      cat: p.cat || '',
      url: p.url,
      img: p.img || null,
      gallery: p.gallery || [],
      cut: Boolean(p.cut),
      brand: p.brand || null,
      sizes: p.sizes || [],
    }));
}

export function syncManifest(products = loadProducts(), sections = loadSections()) {
  const manifest = toManifest(products, sections);
  writeJSON(paths.manifest, manifest, false);
  return manifest;
}

// --- разделы --------------------------------------------------------------
// Ключ раздела — сегмент URL (figure-skates), а не имя категории: имена
// в данных набраны как придётся («Хранение» против «Хранение/уход за коньками»),
// а сегмент один и тот же и в адресе товара, и в адресе страницы раздела.

export const loadSections = () => readJSON(paths.sections, []);
export const saveSections = (list) => writeJSON(paths.sections, list);

// --- остальной контент ----------------------------------------------------

export const loadSite = () => readJSON(paths.site, {});
export const saveSite = (data) => writeJSON(paths.site, data);

// Телефон в href="tel:" — только цифры и плюс, без пробелов/скобок/дефисов.
export const digits = (s) => String(s || '').replace(/[^\d+]/g, '');

export const loadHome = () => readJSON(paths.home, {});
export const saveHome = (data) => writeJSON(paths.home, data);

// Подборки товаров на главной — карусели «Новинки» и «Скидки и акции»
// (см. tools/build-home.mjs). Заголовки правятся как обычный текстовый слот
// (tools/pages.mjs подхватывает <h2 class="section-title">) — здесь только
// известные ключи и подписи для админки, состав и порядок товаров лежат
// в content/home.json по этим же ключам.
export const HOME_COLLECTIONS = [
  { key: 'new', title: 'Новинки' },
  { key: 'sale', title: 'Скидки и акции' },
];

export const loadPages = () => readJSON(paths.pages, {});
export const savePages = (data) => writeJSON(paths.pages, data);

// --- вспомогательное ------------------------------------------------------

// Сегменты адреса товара: /catalog/<раздел>/[<подраздел>/]<id>/
export function segments(url) {
  const seg = String(url || '').split('/').filter(Boolean);
  return {
    top: seg[0] === 'catalog' ? seg[1] || null : null,
    sub: seg[0] === 'catalog' && seg.length >= 4 ? seg[2] : null,
    id: seg[seg.length - 1] || null,
  };
}

// Транслит для имён файлов и слагов новых разделов: кириллица в пути доживёт
// до боевого сервера и сломается там. Та же таблица, что в build-catalog.mjs.
const RU = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };

export const slug = (s) => String(s || '').toLowerCase().replace(/[а-яё]/g, (c) => RU[c] ?? '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 44);
