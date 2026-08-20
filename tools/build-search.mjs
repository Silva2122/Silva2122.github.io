// Индекс для поиска на сайте (см. поиск в assets/js/shop.js) — та же выборка,
// что видят посетители (tools/visible.mjs), но заметно легче манифеста:
// без галереи и размеров, с уже посчитанной ценой «от». Отдельный файл,
// а не поле в assets/products.json: тот — вход для генераторов страниц
// и получает более сотни лишних для поиска байт на карточку (галерея, размеры).
//
// Публикация гоняет этот скрипт вместе с build-pages/build-catalog/build-products
// (см. admin/publish.mjs) — руками отдельно запускать не обязательно, разве что
// на чистой копии сразу после правки content/products.json.
import { loadProducts, writeJSON, ROOT } from './content.mjs';
import { isVisible } from './visible.mjs';
import { join } from 'node:path';

const OUT = join(ROOT, 'assets', 'search.json');

const products = loadProducts();
const index = products.filter(isVisible).map((p) => {
  // «От» — та же арифметика, что у цены карточки в build-catalog.mjs:
  // если у размеров цены разные, честнее показать минимальную с пометкой.
  const sizePrices = (p.sizes || []).map((s) => s.price ?? p.price).filter((n) => n != null);
  const price = sizePrices.length ? Math.min(...sizePrices) : (p.price ?? null);
  const priceFrom = sizePrices.length > 0 && new Set(sizePrices).size > 1;
  return {
    id: p.id,
    name: p.name,
    url: p.url,
    img: p.img,
    cat: p.cat || '',
    brand: p.brand || null,
    price,
    priceFrom,
  };
});

writeJSON(OUT, index, false);
console.log(`Индекс поиска: ${index.length} товаров → assets/search.json`);
