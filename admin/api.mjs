// API админки: всё, что интерфейс запрашивает по /api/*.
//
// Читает и пишет content/ — тот же слой, из которого собирают страницы
// генераторы в tools/. Никакой своей копии данных у админки нет: что здесь
// сохранено, то и уедет в сборку.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, loadProducts, saveProducts, loadSections, saveSections,
  loadSite, saveSite, loadPages, savePages, segments, slug,
} from '../tools/content.mjs';
import { slotsOf, sitePages, zonesFor, pageTitle } from '../tools/pages.mjs';
import { json, fail, readBody, readJSONBody } from './http.mjs';
import { COOKIE, TTL_DAYS, checkPassword, issueToken, validToken, cookieOf, secureCookie } from './auth.mjs';
import {
  PRODUCT_IMG, SECTION_IMG, PAGE_IMG,
  saveShot, shotName, refreshMain, removeAsset, saveHero,
} from './images.mjs';
import { startPublish, publishState, isRunning } from './publish.mjs';

// --- данные для интерфейса ------------------------------------------------

// Список товаров рисуется таблицей, и описания в нём не нужны: 1416 описаний
// это два мегабайта на каждый запрос списка. Полный товар отдаётся отдельно.
const brief = (p) => ({
  id: p.id,
  name: p.name,
  price: p.price,
  oldPrice: p.oldPrice,
  available: p.available !== false,
  cat: p.cat,
  url: p.url,
  img: p.img,
  photos: (p.gallery || []).length,
  sizes: (p.sizes || []).length,
  hidden: Boolean(p.hidden),
  brand: p.brand || null,
});

// Подразделы нигде не перечислены — они выводятся из адресов товаров,
// как и всё остальное дерево каталога. Заголовок берём из поля cat
// («Раздел/Подраздел»), ключ — из сегмента адреса.
function subsOf(products, key) {
  const map = new Map();
  for (const p of products) {
    const { top, sub } = segments(p.url);
    if (top !== key || !sub) continue;
    const title = (p.cat || '').split('/')[1]?.trim() || sub;
    if (!map.has(sub)) map.set(sub, { key: sub, title, count: 0 });
    map.get(sub).count++;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function sectionsWithCounts() {
  const products = loadProducts();
  const count = new Map();
  for (const p of products) {
    const { top } = segments(p.url);
    if (!top) continue;
    if (!count.has(top)) count.set(top, { total: 0, shown: 0 });
    const c = count.get(top);
    c.total++;
    if (!p.hidden && p.img) c.shown++;
  }
  return loadSections()
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .map((s) => ({
      ...s,
      total: count.get(s.key)?.total || 0,
      shown: count.get(s.key)?.shown || 0,
      subs: subsOf(products, s.key),
    }));
}

// --- маршруты -------------------------------------------------------------

export async function api(req, res, path, query, cfg) {
  const authed = validToken(cfg, cookieOf(req, COOKIE));

  // --- вход ---
  if (path === '/api/login' && req.method === 'POST') {
    const { login, password } = await readJSONBody(req);
    if (login !== cfg.login || !checkPassword(cfg, String(password || ''))) {
      return fail(res, 'Неверный логин или пароль', 401);
    }
    res.setHeader('Set-Cookie',
      `${COOKIE}=${issueToken(cfg)}; Path=/; Max-Age=${TTL_DAYS * 24 * 3600}; HttpOnly; SameSite=Lax${secureCookie(req)}`);
    return json(res, { ok: true });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie(req)}`);
    return json(res, { ok: true });
  }

  if (path === '/api/session') {
    return json(res, { authed, login: authed ? cfg.login : null });
  }

  // Всё остальное — только для вошедшего.
  if (!authed) return fail(res, 'Нужно войти', 401);

  // --- сводка ---
  if (path === '/api/overview') {
    const products = loadProducts();
    const publish = publishState();
    return json(res, {
      products: products.length,
      shown: products.filter((p) => !p.hidden && p.img).length,
      hidden: products.filter((p) => p.hidden).length,
      noPhoto: products.filter((p) => !p.img).length,
      sections: loadSections().length,
      publish: { running: publish.running, ok: publish.ok, finishedAt: publish.finishedAt },
    });
  }

  // --- товары ---
  if (path === '/api/products' && req.method === 'GET') {
    const q = (query.get('q') || '').trim().toLowerCase();
    const section = query.get('section') || '';
    const state = query.get('state') || '';       // shown | hidden | nophoto
    const page = Math.max(1, Number(query.get('page') || 1));
    const per = Math.min(200, Number(query.get('per') || 40));

    let list = loadProducts();
    if (section) list = list.filter((p) => segments(p.url).top === section);
    if (state === 'shown') list = list.filter((p) => !p.hidden && p.img);
    if (state === 'hidden') list = list.filter((p) => p.hidden);
    if (state === 'nophoto') list = list.filter((p) => !p.img);
    if (q) {
      list = list.filter((p) =>
        String(p.name || '').toLowerCase().includes(q) ||
        String(p.id).includes(q) ||
        String(p.brand || '').toLowerCase().includes(q));
    }

    return json(res, {
      total: list.length,
      page,
      pages: Math.max(1, Math.ceil(list.length / per)),
      items: list.slice((page - 1) * per, page * per).map(brief),
    });
  }

  if (path === '/api/products' && req.method === 'POST') {
    const body = await readJSONBody(req);
    const products = loadProducts();
    const section = loadSections().find((s) => s.key === body.section);
    if (!section) return fail(res, 'Не выбран раздел');

    // Новый артикул — следом за самым большим из существующих: адреса товаров
    // строятся из него, и повторный номер увёл бы новый товар на чужую страницу.
    const id = String(products.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0) + 1);

    const sub = (body.sub || '').trim();
    const url = sub ? `/catalog/${section.key}/${sub}/${id}/` : `/catalog/${section.key}/${id}/`;
    const subTitle = sub ? subsOf(products, section.key).find((x) => x.key === sub)?.title : null;

    const product = {
      id,
      name: (body.name || 'Новый товар').trim(),
      price: body.price ?? null,
      oldPrice: body.oldPrice ?? null,
      available: body.available !== false,
      cat: subTitle ? `${section.name}/${subTitle}` : section.name,
      url,
      brand: body.brand || null,
      sizes: body.sizes || [],
      description: body.description || [],
      img: null,
      gallery: [],
      cut: false,
      hidden: false,
    };

    products.unshift(product);
    saveProducts(products);
    return json(res, product, 201);
  }

  const productMatch = path.match(/^\/api\/products\/([^/]+)(\/photo)?$/);
  if (productMatch) {
    const id = decodeURIComponent(productMatch[1]);
    const isPhoto = Boolean(productMatch[2]);
    const products = loadProducts();
    const idx = products.findIndex((p) => String(p.id) === id);
    if (idx === -1) return fail(res, 'Товар не найден', 404);
    const product = products[idx];

    if (req.method === 'GET' && !isPhoto) return json(res, product);

    // Заливка кадра: тело запроса — сам файл, без multipart. Разбирать границы
    // формы ради одного поля незачем, а fetch(body: file) шлёт файл как есть.
    if (req.method === 'POST' && isPhoto) {
      const buffer = await readBody(req);
      if (!buffer.length) return fail(res, 'Пустой файл');
      mkdirSync(PRODUCT_IMG, { recursive: true });
      const name = shotName(product.id, buffer);
      try {
        await saveShot(buffer, join(PRODUCT_IMG, name), 1000);
      } catch {
        return fail(res, 'Не похоже на картинку — нужен JPG, PNG или WebP');
      }
      product.gallery = [...(product.gallery || []), `assets/img/products/${name}`];
      await refreshMain(product);
      saveProducts(products);
      return json(res, product);
    }

    if (req.method === 'PUT' && !isPhoto) {
      const body = await readJSONBody(req);
      const before = (product.gallery || [])[0];

      // Правим только то, что редактируется в админке: адрес и артикул товара
      // менять нельзя — на них завязаны и страница, и ссылки с неё.
      Object.assign(product, {
        name: String(body.name ?? product.name).trim(),
        price: body.price === '' || body.price == null ? null : Number(body.price),
        oldPrice: body.oldPrice === '' || body.oldPrice == null ? null : Number(body.oldPrice),
        available: body.available !== false,
        brand: (body.brand || '').trim() || null,
        sizes: Array.isArray(body.sizes) ? body.sizes.filter(Boolean) : product.sizes,
        description: Array.isArray(body.description)
          ? body.description.map((s) => String(s).trim()).filter(Boolean)
          : product.description,
        hidden: Boolean(body.hidden),
      });

      if (Array.isArray(body.gallery)) {
        const kept = new Set(body.gallery);
        for (const old of product.gallery || []) if (!kept.has(old)) removeAsset(old);
        product.gallery = body.gallery.filter((g) => existsSync(join(ROOT, g)));
      }
      // Главный кадр пересобираем, только если первый в галерее сменился:
      // sharp на каждое сохранение формы — это лишняя секунда на пустом месте.
      if ((product.gallery || [])[0] !== before) await refreshMain(product);

      saveProducts(products);
      return json(res, product);
    }

    if (req.method === 'DELETE' && !isPhoto) {
      for (const g of product.gallery || []) removeAsset(g);
      removeAsset(product.img);
      products.splice(idx, 1);
      saveProducts(products);
      return json(res, { ok: true });
    }
  }

  // --- разделы ---
  if (path === '/api/sections' && req.method === 'GET') {
    return json(res, sectionsWithCounts());
  }

  if (path === '/api/sections' && req.method === 'PUT') {
    const body = await readJSONBody(req);
    if (!Array.isArray(body)) return fail(res, 'Ожидался список разделов');
    const current = new Map(loadSections().map((s) => [s.key, s]));
    saveSections(body.map((s, i) => ({
      ...current.get(s.key),
      key: s.key,
      name: current.get(s.key)?.name || s.name || s.title,
      title: String(s.title || '').trim() || s.key,
      img: s.img ?? current.get(s.key)?.img ?? null,
      cut: s.cut ?? current.get(s.key)?.cut ?? false,
      hidden: Boolean(s.hidden),
      order: i,
    })));
    return json(res, sectionsWithCounts());
  }

  const sectionPhoto = path.match(/^\/api\/sections\/([^/]+)\/photo$/);
  if (sectionPhoto && req.method === 'POST') {
    const sections = loadSections();
    const section = sections.find((s) => s.key === decodeURIComponent(sectionPhoto[1]));
    if (!section) return fail(res, 'Раздел не найден', 404);

    const buffer = await readBody(req);
    if (!buffer.length) return fail(res, 'Пустой файл');
    mkdirSync(SECTION_IMG, { recursive: true });
    const name = shotName(`cat-${slug(section.title)}`, buffer);
    try {
      await saveShot(buffer, join(SECTION_IMG, name), 1000);
    } catch {
      return fail(res, 'Не похоже на картинку — нужен JPG, PNG или WebP');
    }
    if (section.img && section.img.includes('/catalog-raw/')) removeAsset(section.img);
    section.img = `assets/img/catalog-raw/${name}`;
    // Кадр от владельца снят как есть, с фоном: карточке раздела нужен
    // модификатор --raw, иначе фон встанет с полями, как у вырезанного.
    section.cut = false;
    saveSections(sections);
    return json(res, sectionsWithCounts());
  }

  // --- контакты ---
  if (path === '/api/site') {
    if (req.method === 'GET') return json(res, loadSite());
    if (req.method === 'PUT') {
      const body = await readJSONBody(req);
      saveSite({ ...loadSite(), ...body });
      return json(res, loadSite());
    }
  }

  // --- тексты страниц ---
  // Правда о тексте лежит в самой странице, а content/pages.json — очередь
  // правок с прошлой публикации. Поэтому список полей всегда собирается
  // из разметки, а сверху накладывается несохранённое.
  if (path === '/api/pages' && req.method === 'GET') {
    const queued = loadPages();
    return json(res, sitePages().map((file) => {
      const html = readFileSync(join(ROOT, file), 'utf8');
      return {
        file,
        title: pageTitle(file, html),
        slots: slotsOf(html, zonesFor(file)).length,
        pending: Object.keys(queued[file]?.edits || {}).length,
        url: '/' + file.replace(/index\.html$/, ''),
      };
    }));
  }

  const pageMatch = path.match(/^\/api\/pages\/(.+)$/);
  if (pageMatch) {
    const file = decodeURIComponent(pageMatch[1]);
    if (!sitePages().includes(file)) return fail(res, 'Такой страницы нет', 404);

    const html = readFileSync(join(ROOT, file), 'utf8');
    const queued = loadPages();
    const edits = queued[file]?.edits || {};

    if (req.method === 'GET') {
      return json(res, {
        file,
        title: pageTitle(file, html),
        url: '/' + file.replace(/index\.html$/, ''),
        slots: slotsOf(html, zonesFor(file)).map((s) => ({
          key: s.key,
          label: s.label,
          text: edits[s.key] ? edits[s.key].text : s.text,
          original: s.text,
          changed: Boolean(edits[s.key]),
        })),
      });
    }

    if (req.method === 'PUT') {
      const body = await readJSONBody(req);
      const slots = new Map(slotsOf(html, zonesFor(file)).map((s) => [s.key, s]));
      const next = { ...edits };

      for (const [key, text] of Object.entries(body.edits || {})) {
        const slot = slots.get(key);
        if (!slot) continue;
        // Вернули как было — правку из очереди убираем, иначе она осталась бы
        // висеть и лишний раз переписывала страницу тем же текстом.
        if (String(text).trim() === slot.text) delete next[key];
        else next[key] = { was: slot.text, text: String(text).trim() };
      }

      queued[file] = { edits: next };
      if (!Object.keys(next).length) delete queued[file];
      savePages(queued);
      return json(res, { saved: Object.keys(next).length });
    }
  }

  // --- картинки страниц ---
  if (path === '/api/hero' && req.method === 'POST') {
    const buffer = await readBody(req);
    if (!buffer.length) return fail(res, 'Пустой файл');
    try {
      return json(res, { path: await saveHero(buffer) });
    } catch {
      return fail(res, 'Не похоже на фотографию — нужен JPG, PNG или WebP');
    }
  }

  // Произвольная картинка для страницы: складываем в assets/img/pages/,
  // возвращаем путь — интерфейс подставляет его в нужное поле.
  if (path === '/api/upload' && req.method === 'POST') {
    const buffer = await readBody(req);
    if (!buffer.length) return fail(res, 'Пустой файл');
    mkdirSync(PAGE_IMG, { recursive: true });
    const name = shotName(slug(query.get('name') || 'img') || 'img', buffer);
    try {
      await saveShot(buffer, join(PAGE_IMG, name), Number(query.get('size') || 1600));
    } catch {
      return fail(res, 'Не похоже на картинку — нужен JPG, PNG или WebP');
    }
    return json(res, { path: `assets/img/pages/${name}` });
  }

  // --- публикация ---
  if (path === '/api/publish' && req.method === 'POST') {
    if (isRunning()) return fail(res, 'Публикация уже идёт', 409);
    const body = await readJSONBody(req);
    startPublish({ push: Boolean(body.push) });      // без await: следим через GET
    return json(res, { started: true });
  }

  if (path === '/api/publish') return json(res, publishState());

  return fail(res, 'Нет такого метода', 404);
}
