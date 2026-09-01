// Собирает страницы товаров: /catalog/<раздел>/[<подраздел>/]<id>/index.html
//
// Раньше карточка в разделе вела на боевой axelnn.ru — своей страницы товара
// у нового сайта не было. Здесь она появляется: галерея, цена, выбор размера,
// кнопки «в корзину», «в избранное» и «поделиться», описание, характеристики
// и лента похожих товаров.
//
//   node tools/build-products.mjs            все товары
//   node tools/build-products.mjs --limit 20 первые 20, для проверки
//   node tools/build-products.mjs --dry      показать, ничего не записывая
//
// Порядок важен: сначала tools/build-catalog.mjs (он кладёт в index.html
// актуальное меню каталога, а шапку мы берём оттуда целиком), потом этот
// скрипт. Данные — assets/products.json (картинки, цены, размеры) и
// content/products.json (описания, которые правит владелец через админку).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { splitVisible, HIDE_NO_PHOTO } from './visible.mjs';
import { loadProducts, hasContent, loadSite, digits } from './content.mjs';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = argv.includes('--dry');
const LIMIT = Number(arg('--limit', 0));

// Счётчик Яндекс.Метрики (id 112096375, заведён 2026-08-31) — тот же код,
// что и в tools/build-catalog.mjs, см. комментарий там.
const METRIKA = `<script type="text/javascript">
    (function(m,e,t,r,i,k,a){
        m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
        m[i].l=1*new Date();
        for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
        k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
    })(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=112096375', 'ym');

    ym(112096375, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/112096375" style="position:absolute; left:-9999px;" alt="" /></div></noscript>`;

const manifest = JSON.parse(readFileSync(join(ROOT, 'assets', 'products.json'), 'utf8'));

// Описания живут в content/products.json — там их правит админка, и там они
// уже разбиты на абзацы. Донора хватает только на первый прогон на чистой
// копии: он на 90 МБ, в репозиторий не попадает и на хостинге его нет.
const donorFile = join(ROOT, 'old_version', 'products.json');
const source = hasContent()
  ? loadProducts()
  : (existsSync(donorFile) ? JSON.parse(readFileSync(donorFile, 'utf8')).products : []);
if (!hasContent()) console.log('⚠ Нет content/products.json — описания берём из донора');

const byId = new Map(source.map((p) => [String(p.id), p]));

// Телефон берём из content/site.json — если вписать его строкой здесь,
// правка в админке до этого шаблона не доедет, и на карточке товара
// останется прошлый номер, хотя шапка и подвал уже покажут новый.
const site = loadSite();
const phoneHref = digits(site.phone);
const phoneText = site.phone || '';

// Те же таблицы, что в build-catalog.mjs: имена разделов в доноре набраны
// как придётся, а в крошках и характеристиках должно стоять человеческое.
const TITLES = {
  'Хранение': 'Хранение и уход',
  'Сумки,рюкзаки': 'Сумки и рюкзаки',
  'ЕДИНЫЙ КОМАНДНЫЙ СТИЛЬ': 'Единый командный стиль',
  'Тренажеры': 'Тренажёры',
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const tidy = (s) => String(s || '')
  .replace(/,(?=\S)/g, ', ')
  .replace(/\s+/g, ' ')
  .replace(/\s*\.\s*$/, '')
  .trim();

const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '&nbsp;');
const href = (path) => path.split('/').map(encodeURIComponent).join('/').replace(/%23/g, '#');

function plural(n, one, few, many) {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 10 || h > 20)) return few;
  return many;
}

// --- описание -------------------------------------------------------------
// В content/products.json описание — уже готовый массив абзацев: его чистит
// migrate-content.mjs и дальше правит владелец. Строка приезжает только
// с донора, где description — весь текстовый слой детальной страницы Aspro:
// после самого описания идут форма отзыва, форма вопроса и хвост «быстрого
// просмотра» соседних товаров. Режем по первому же их маркеру.
const JUNK = /(Отзывы|Оставить отзыв|Задать вопрос|Быстрый просмотр|Перетащите файлы|Ничего не найдено|Характеристики товара)/;

function description(p) {
  if (Array.isArray(p.description)) return p.description.filter(Boolean);
  let text = (p.description || '').replace(/\r/g, '');
  const hit = text.match(JUNK);
  if (hit) text = text.slice(0, hit.index);
  return text
    .split('\n')
    .map((s) => s.trim())
    // «Все товары можете посмотреть в нашем Каталоге» — это ссылка из шаблона
    // поставщика, приклеенная к концу описания. Каталог у нас в шапке.
    .map((s) => s.replace(/\s*Все товары можете посмотреть.*$/i, '').trim())
    .filter(Boolean)
    .filter((s) => s.length > 1);
}

// --- дерево разделов ------------------------------------------------------
// Путь раздела выводим из URL товара, а не из categories.json: зеркало
// докачано не полностью, и у части разделов страницы на диске нет вовсе.
// Скрытые товары страницы не получают: критерий общий с каталогом, см.
// tools/visible.mjs. Иначе на них не осталось бы ни одной ссылки, но сама
// страница висела бы в индексе — с пустой галереей вместо фотографии.
const { visible, hidden } = splitVisible(manifest);

const items = visible.map((it) => {
  const seg = it.url.split('/').filter(Boolean);   // ['catalog', раздел, (подраздел), id]
  const [top, sub] = (it.cat || '').split('/').map((s) => s.trim());
  return {
    ...it,
    seg,
    topSeg: seg[1] || null,
    subSeg: seg.length >= 4 ? seg[2] : null,
    topName: TITLES[top] || top || 'Каталог',
    subName: sub || null,
  };
});

// Соседи по подразделу — для ленты «Похожие». Если подраздела нет, берём
// раздел целиком: у «Лезвий» подразделов не заведено вовсе.
const byGroup = new Map();
for (const it of items) {
  const key = it.subSeg ? `${it.topSeg}/${it.subSeg}` : it.topSeg;
  if (!byGroup.has(key)) byGroup.set(key, []);
  byGroup.get(key).push(it);
}

// --- общие куски из главной ----------------------------------------------
const home = readFileSync(join(ROOT, 'index.html'), 'utf8');

function between(html, name) {
  const a = html.indexOf(`<!-- ОБЩЕЕ:${name}:НАЧАЛО -->`);
  const b = html.indexOf(`<!-- ОБЩЕЕ:${name}:КОНЕЦ -->`);
  if (a === -1 || b === -1) throw new Error(`Нет маркеров ОБЩЕЕ:${name} в index.html`);
  return html.slice(a + `<!-- ОБЩЕЕ:${name}:НАЧАЛО -->`.length, b).trim();
}

// Относительные пути поднимаем на глубину страницы. Абсолютные, якоря
// и протоколы не трогаем — см. тот же upN в build-catalog.mjs.
const upN = (s, n) => s.replace(
  /(src|href)="(?!https?:|mailto:|tel:|data:|#|\/)([^"]*)"/g,
  (_, attr, path) => `${attr}="${'../'.repeat(n)}${path}"`,
);

const rawHeader = between(home, 'ШАПКА');
const rawFooter = between(home, 'ПОДВАЛ');
// Закрывающий тег ищем от начала самого скрипта: в шапке есть
// <script src="assets/js/shop.js">, и его </script> стоит раньше по файлу.
const scriptFrom = home.indexOf('<script>');
const script = home.slice(scriptFrom, home.indexOf('</script>', scriptFrom) + '</script>'.length);

// --- разметка -------------------------------------------------------------

// Галерея. Крупный кадр + миниатюры; переключение — в общем скрипте сайта.
// Кадр галереи — либо путь к фото (строка), либо { video, poster } (видео
// из админки, см. admin/video.mjs): на миниатюре и в стейдже до клика в лайтбокс
// показывается постер, как обычное фото, плюс значок play различает их на глаз.
function gallery(it, up) {
  const raw = it.gallery && it.gallery.length ? it.gallery : (it.img ? [it.img] : []);
  const shots = raw.map((s) => (typeof s === 'string' ? { img: s } : { img: s.poster, video: s.video }));
  if (!shots.length) {
    return [
      '      <div class="gallery">',
      '        <div class="gallery__stage"><span class="ph"></span></div>',
      '        <p class="gallery__note">Фотография готовится. Позвоните — расскажем и пришлём кадр.</p>',
      '      </div>',
    ].join('\n');
  }

  const play = '<span class="gallery__thumb-play" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>';

  const thumbs = shots.length > 1 ? [
    '        <div class="gallery__thumbs">',
    ...shots.map((s, i) =>
      // width/height у миниатюры — размер, который ей задаёт CSS, а не размер
      // файла: место под кнопку резервируется до загрузки кадра, и колонка
      // миниатюр не дёргается по мере их подгрузки.
      `          <button type="button" class="gallery__thumb${i === 0 ? ' is-on' : ''}" data-src="${up}${s.img}"${s.video ? ` data-video="${up}${s.video}"` : ''} aria-label="${s.video ? 'Видео' : 'Кадр'} ${i + 1} из ${shots.length}"><img src="${up}${s.img}" width="56" height="56" alt="" loading="lazy">${s.video ? play : ''}</button>`),
    '        </div>',
  ].join('\n') : '';

  return [
    '      <div class="gallery" id="gallery">',
    '        <div class="gallery__stage">',
    `          <img class="gallery__img" id="gallery-img" src="${up}${shots[0].img}" alt="${esc(tidy(it.name))}" width="2400" height="2400" fetchpriority="high">`,
    `          <span class="gallery__stage-play"${shots[0].video ? '' : ' hidden'} aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>`,
    '        </div>',
    thumbs,
    '      </div>',
  ].filter(Boolean).join('\n');
}

// Карточка в ленте похожих: ссылка целиком, без кнопок — в узкой ленте
// они бы отняли место у названия, а купить можно на самой странице товара.
function miniCard(it, up) {
  const media = it.img
    ? `<img class="ph" src="${up}${it.img}" width="1200" height="1200" loading="lazy" alt="${esc(tidy(it.name))}">`
    : '<span class="ph"></span>';
  const price = it.price
    ? `<span class="card__price">${money(it.price)}&nbsp;₽</span>`
    : '<span class="card__price card__price--none">Цена по запросу</span>';
  return [
    `        <a href="${href(it.url)}" class="card">`,
    `          <div class="card__media card__media--fill">${media}</div>`,
    `          <span class="card__name">${esc(tidy(it.name))}</span>`,
    `          <div class="card__prices">${price}</div>`,
    '        </a>',
  ].join('\n');
}

// Строка характеристик. Пустые значения не выводим: «Бренд: —» ничего
// не сообщает, а таблицу удлиняет.
function specRow(label, value) {
  return value ? `        <div class="spec"><dt class="spec__key">${esc(label)}</dt><dd class="spec__val">${value}</dd></div>` : '';
}

function page(it) {
  const depth = it.seg.length;          // /catalog/раздел/подраздел/id/ → 4 уровня до корня
  const up = '../'.repeat(depth);
  const donorItem = byId.get(String(it.id)) || {};
  const descr = description(donorItem);
  const sizes = it.sizes || [];
  const topUrl = `/catalog/${it.topSeg}/`;
  const subUrl = it.subSeg ? `${topUrl}#${it.subSeg}` : null;

  // Похожие: соседи по подразделу, себя исключаем. Товары без фото в ленту
  // не берём — ряд из плейсхолдеров выглядит как незагрузившаяся страница.
  const neighbours = (byGroup.get(it.subSeg ? `${it.topSeg}/${it.subSeg}` : it.topSeg) || [])
    .filter((x) => x.id !== it.id && x.img)
    .slice(0, 12);

  // Цена размера необязательна — пустая берёт цену товара. Если у размеров
  // цены разные, в шапке товара честнее показать «от» самой дешёвой, а не
  // цену товара как есть: она может не соответствовать ни одному размеру.
  const sizePrices = sizes.map((s) => s.price ?? it.price).filter((n) => n != null);
  const fromPrice = sizePrices.length ? Math.min(...sizePrices) : it.price;
  const priceVaries = sizePrices.length > 0 && new Set(sizePrices).size > 1;

  const priceBlock = fromPrice
    ? `<span class="product__price">${priceVaries ? 'от&nbsp;' : ''}${money(fromPrice)}&nbsp;₽</span>` +
      (it.oldPrice && it.oldPrice > fromPrice ? `<span class="product__price-old">${money(it.oldPrice)}&nbsp;₽</span>` : '')
    : '<span class="product__price product__price--none">Цена по запросу</span>';

  const sizeBlock = sizes.length ? [
    '        <div class="sizes">',
    '          <div class="sizes__head">',
    '            <span class="sizes__title">Размер</span>',
    `            <a class="sizes__help" href="${up}help/">Как подобрать</a>`,
    '          </div>',
    '          <div class="sizes__list">',
    ...sizes.map((s, i) =>
      `            <label class="size"><input type="radio" name="size" value="${esc(s.size)}" data-price="${s.price ?? it.price ?? 0}"${sizes.length === 1 && i === 0 ? ' checked' : ''}><span class="size__val">${esc(s.size)}</span></label>`),
    '          </div>',
    '        </div>',
  ].join('\n') : '';

  const descrBlock = descr.length ? [
    '  <section class="product-section container">',
    '    <h2 class="product-section__title">Описание</h2>',
    '    <div class="prose product-descr">',
    ...descr.map((line) => `      <p>${esc(line)}</p>`),
    '    </div>',
    '  </section>',
  ].join('\n') : '';

  const specs = [
    specRow('Артикул', esc(it.id)),
    specRow('Бренд', it.brand ? esc(it.brand) : ''),
    specRow('Раздел', `<a href="${href(topUrl)}">${esc(tidy(it.topName))}</a>`),
    it.subName && subUrl ? specRow('Подраздел', `<a href="${href(subUrl)}">${esc(tidy(it.subName))}</a>`) : '',
    specRow('Размеры', sizes.length ? esc(sizes.map((s) => s.size).join(', ')) : ''),
    specRow('Наличие', it.available ? 'В наличии' : 'Под заказ'),
  ].filter(Boolean).join('\n');

  // Заголовок здесь того же кегля, что «Описание» и «Характеристики»:
  // .section-title с главной (до 50px) рядом с ними читался как начало
  // новой страницы, а не как третий блок карточки товара.
  const similar = neighbours.length ? [
    '  <section class="product-section container">',
    '    <div class="section__head">',
    '      <h2 class="product-section__title">Похожие товары</h2>',
    `      <a class="section__link" href="${href(subUrl || topUrl)}">Весь раздел`,
    '        <svg width="34" height="8" viewBox="0 0 56 8" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M0 4h51M48 1l5 3-5 3"/></svg>',
    '      </a>',
    '    </div>',
    '    <div class="carousel">',
    '      <div class="carousel__track cx-scroll">',
    ...neighbours.map((x) => miniCard(x, up)),
    '      </div>',
    '      <button type="button" class="carousel__nav carousel__prev" aria-label="Предыдущие товары" disabled>',
    '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    '      </button>',
    '      <button type="button" class="carousel__nav carousel__next" aria-label="Следующие товары">',
    '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    '      </button>',
    '    </div>',
    '    <div class="progress"><span class="progress__bar"></span></div>',
    '  </section>',
  ].join('\n') : '';

  // Микроразметка: без неё товар в поиске идёт без цены и наличия.
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: tidy(it.name),
    sku: String(it.id),
    ...(it.brand ? { brand: { '@type': 'Brand', name: it.brand } } : {}),
    ...(descr.length ? { description: descr.join(' ').slice(0, 400) } : {}),
    ...(it.img ? { image: `https://axelnn.ru/${it.img}` } : {}),
    ...(it.price ? {
      offers: {
        '@type': 'Offer',
        price: it.price,
        priceCurrency: 'RUB',
        availability: it.available ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder',
        url: `https://axelnn.ru${it.url}`,
      },
    } : {}),
  });

  const breadcrumbItems = [
    { name: 'Главная', url: '/' },
    { name: tidy(it.topName), url: topUrl },
    ...(it.subName && subUrl ? [{ name: tidy(it.subName), url: subUrl }] : []),
    { name: tidy(it.name) },
  ];
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbItems.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      ...(c.url ? { item: `https://axelnn.ru${c.url}` } : {}),
    })),
  });

  const summary = descr.length
    ? descr.join(' ').slice(0, 155)
    : `${tidy(it.name)} — ${tidy(it.topName)}. Магазин Аксель·НН в Нижнем Новгороде, доставка по России.`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(tidy(it.name))} — купить в Нижнем Новгороде | Аксель·НН</title>
<meta name="description" content="${esc(summary)}">
<link rel="canonical" href="https://axelnn.ru${it.url}">
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(tidy(it.name))}">
<meta property="og:description" content="${esc(summary)}">
${it.img ? `<meta property="og:image" content="https://axelnn.ru/${it.img}">` : ''}
<meta property="og:url" content="https://axelnn.ru${it.url}">
<meta name="theme-color" content="#0E7A88">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='25' font-size='26'>⛸</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600&family=Playfair+Display:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${up}assets/css/style.css">
<script type="application/ld+json">${ld}</script>
<script type="application/ld+json">${breadcrumbLd}</script>
${METRIKA}
</head>
<body>

<!-- Страницу целиком собирает tools/build-products.mjs. Руками не править. -->

${upN(rawHeader, depth)}

<article class="product-page">
  <div class="container">
    <nav class="crumbs" aria-label="Хлебные крошки">
      <a href="/">Главная</a>
      <span class="crumbs__sep" aria-hidden="true">/</span>
      <a href="/catalog/">Каталог</a>
      <span class="crumbs__sep" aria-hidden="true">/</span>
      <a href="${href(topUrl)}">${esc(tidy(it.topName))}</a>
${it.subName && subUrl ? `      <span class="crumbs__sep" aria-hidden="true">/</span>
      <a href="${href(subUrl)}">${esc(tidy(it.subName))}</a>` : ''}
      <span class="crumbs__sep" aria-hidden="true">/</span>
      <span class="crumbs__current" aria-current="page">${esc(tidy(it.name))}</span>
    </nav>

    <div class="product">
${gallery(it, up)}

      <!-- Данные для корзины висят на этом блоке: кнопки внутри него читают
           их через [data-product]. Пути к картинке и странице — от корня,
           корзина рисуется на страницах любой глубины. -->
      <div class="product__buy" data-product
           data-id="${esc(it.id)}"
           data-name="${esc(tidy(it.name))}"
           data-price="${fromPrice || 0}"
           data-img="${it.img ? '/' + it.img : ''}"
           data-url="${esc(it.url)}"
           data-need-size="${sizes.length > 1}">

        ${it.brand ? `<span class="product__brand">${esc(it.brand)}</span>` : ''}
        <h1 class="product__title">${esc(tidy(it.name))}</h1>

        <div class="product__meta">
          <span class="product__sku">Артикул ${esc(it.id)}</span>
          <span class="product__stock${it.available ? '' : ' product__stock--no'}">${it.available ? 'В наличии' : 'Под заказ'}</span>
        </div>

        <div class="product__prices">${priceBlock}</div>

${sizeBlock}

        <div class="product__actions">
          <button type="button" class="btn product__add" data-add>Добавить в корзину</button>
          <button type="button" class="iconbtn" data-fav aria-pressed="false" aria-label="В избранное">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M12 20.5 4.4 12.9a4.6 4.6 0 0 1 6.5-6.5l1.1 1.1 1.1-1.1a4.6 4.6 0 0 1 6.5 6.5L12 20.5Z"/></svg>
          </button>
          <button type="button" class="iconbtn" data-share aria-label="Поделиться">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.4 10.8 15.6 6.5M8.4 13.2l7.2 4.3"/></svg>
          </button>
        </div>

        <ul class="perks">
          <li class="perk">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/></svg>
            <span>Доставка по России, самовывоз в&nbsp;Нижнем — <a href="${up}help/delivery/">условия</a></span>
          </li>
          <li class="perk">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4 19h16M7 19V9l5-4 5 4v10"/><path d="M10 19v-5h4v5"/></svg>
            <span>Примерка в&nbsp;магазине — поможем подобрать по&nbsp;ноге</span>
          </li>
          <li class="perk">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 9.5-4.1-1.9-7-5.3-7-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>
            <span>Гарантия и&nbsp;возврат 14&nbsp;дней — <a href="${up}help/warranty/">подробнее</a></span>
          </li>
        </ul>

        <p class="product__ask">Не уверены с&nbsp;размером? Позвоните: <a href="tel:${phoneHref}">${phoneText}</a></p>
      </div>
    </div>
  </div>

${descrBlock}

  <section class="product-section container">
    <h2 class="product-section__title">Характеристики</h2>
    <dl class="specs">
${specs}
    </dl>
  </section>

${similar}
</article>

${upN(rawFooter, depth)}

${script}

</body>
</html>
`;
}

// --- запись ---------------------------------------------------------------
const list = LIMIT ? items.slice(0, LIMIT) : items;
let built = 0, skipped = 0;

for (const it of list) {
  if (it.seg[0] !== 'catalog' || !it.topSeg || !it.id) { skipped++; continue; }
  const dir = join(ROOT, ...it.seg);
  if (!DRY) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), page(it), 'utf8');
  }
  built++;
  if (built % 300 === 0) console.log(`  ${built}/${list.length}…`);
}

// --- убираем страницы скрытых и удалённых товаров --------------------------
// Прошлый прогон собрал страницу на каждый видимый тогда товар — включая те,
// что с тех пор скрыты (нет фото, закрыт раздел) или вовсе исчезли из
// манифеста (товар удалили в админке). Идём по диску, а не по списку скрытых
// из текущего манифеста: удалённый товар в манифесте не значится вообще,
// и по одной только разнице «было видимо — стало скрыто» его страницу
// было бы не найти. Ссылок на такие страницы не осталось, но по прямому
// адресу они бы открывались со вчерашними (или вовсе пустыми) данными.
// При --limit не трогаем ничего: это частичный прогон для проверки.
let removed = 0;
if (!LIMIT) {
  const visibleIds = new Set(visible.map((it) => String(it.id)));
  // Товар мог не исчезнуть, а переехать в другой раздел/подраздел (кнопка
  // «Раздел» в карточке товара, admin/api.mjs) — id остаётся видимым, но по
  // старому пути страница ему больше не принадлежит. Сверяем не только id,
  // но и сам путь, иначе старая страница остаётся сиротой навсегда — ровно
  // тот же класс бага, что чинили 19.08.2026 для удалённых товаров.
  const pathById = new Map(visible.map((it) => [String(it.id), it.url.split('/').filter(Boolean).join('/')]));
  const marker = 'Страницу целиком собирает tools/build-products.mjs';

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name !== 'index.html') continue;
      const seg = relative(ROOT, dir).split(/[\\/]/).filter(Boolean);
      const id = seg[seg.length - 1];
      if (seg[0] !== 'catalog' || seg.length < 3) continue;
      const isCurrent = visibleIds.has(id) && pathById.get(id) === seg.join('/');
      if (isCurrent) continue;
      // Страховка от сноса чужого файла: удаляем только подписанное нами.
      if (!readFileSync(p, 'utf8').includes(marker)) continue;
      if (!DRY) rmSync(p);
      removed++;
    }
  };
  walk(join(ROOT, 'catalog'));

  // После сноса остаются пустые папки товаров и подразделов — в них уже нечему
  // лежать, а в дереве проекта они выглядят как существующие адреса.
  const prune = (dir) => {
    let empty = true;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && prune(join(dir, e.name))) continue;
      empty = false;
    }
    if (empty && !DRY) rmSync(dir, { recursive: true });
    return empty;
  };
  const catalogDir = join(ROOT, 'catalog');
  for (const e of readdirSync(catalogDir, { withFileTypes: true })) {
    if (e.isDirectory()) prune(join(catalogDir, e.name));
  }
}

console.log(`\n${DRY ? '[dry] ' : ''}Страниц товаров: ${built}${skipped ? `, пропущено: ${skipped}` : ''}`);

if (removed) console.log(`  убрано страниц скрытых товаров: ${removed}`);
if (HIDE_NO_PHOTO && hidden.length) console.log(`  скрыто без фото: ${hidden.length} из ${manifest.length}`);
const withPhoto = list.filter((it) => it.img).length;
const withDescr = list.filter((it) => description(byId.get(String(it.id)) || {}).length).length;
console.log(`  с фотографией : ${withPhoto}`);
console.log(`  с описанием   : ${withDescr}`);
console.log(`  ${plural(built, 'страница лежит', 'страницы лежат', 'страниц лежат')} по адресам из products.json`);
