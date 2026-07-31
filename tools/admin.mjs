// Админка сайта: сервер с API поверх content/ и файлов сайта.
//
//   node tools/admin.mjs                       http://127.0.0.1:4180/admin/
//   node tools/admin.mjs --port 4180
//   node tools/admin.mjs --set-password        сменить логин и пароль
//   node tools/admin.mjs --host 0.0.0.0        пустить в сеть (только за HTTPS!)
//
// Сайт статический, бэкенда у него нет и не будет: страницы собираются
// генераторами и лежат файлами. Поэтому админка — не «движок сайта», а
// редактор его исходников: правит content/*.json и кадры в assets/img/,
// а потом по кнопке «Опубликовать» гоняет те же build-catalog.mjs и
// build-products.mjs, что мы гоняем руками.
//
// Отсюда два следствия. Первое: между правкой и её появлением на сайте
// есть шаг публикации — так же, как между «сохранил файл» и «залил».
// Второе: переезд на нормальный хостинг переносит ровно этот скрипт,
// интерфейс в admin/ и content/ — трогать ничего не придётся.
//
// Раздаёт сервер и сам сайт (тот же корень), чтобы результат правки можно
// было посмотреть в соседней вкладке, не поднимая serve.mjs отдельно.
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, extname, resolve, sep, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import sharp from 'sharp';
import {
  ROOT, paths, readJSON, writeJSON,
  loadProducts, saveProducts, loadSections, saveSections,
  loadSite, saveSite, loadPages, savePages,
  syncManifest, segments, slug,
} from './content.mjs';
import { slotsOf, sitePages, zonesFor, pageTitle } from './pages.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 4180));
const HOST = arg('--host', '127.0.0.1');

const ADMIN_DIR = join(ROOT, 'admin');
const PRODUCT_IMG = join(ROOT, 'assets', 'img', 'products');
const SECTION_IMG = join(ROOT, 'assets', 'img', 'catalog-raw');
const PAGE_IMG = join(ROOT, 'assets', 'img', 'pages');
const CONFIG = join(ROOT, 'content', '.admin.json');

// ==========================================================================
// Вход
// ==========================================================================
// Пароль храним не сам, а scrypt-хеш с солью: файл конфигурации лежит рядом
// с сайтом, и пароль из него не должен читаться глазами. Куку подписываем
// HMAC вместо хранения списка сессий в памяти — иначе перезапуск сервера
// выкидывал бы владельца из админки посреди правки.

const COOKIE = 'axelnn_admin';
const DAY = 24 * 60 * 60 * 1000;

function makeConfig(login, password) {
  const salt = randomBytes(16).toString('hex');
  const cfg = {
    login,
    salt,
    hash: scryptSync(password, salt, 64).toString('hex'),
    secret: randomBytes(32).toString('hex'),
  };
  writeJSON(CONFIG, cfg);
  return cfg;
}

function loadConfig() {
  const cfg = readJSON(CONFIG, null);
  if (cfg?.hash) return cfg;
  // Первый запуск: заводим вход по умолчанию и печатаем его в консоль.
  // Пароль случайный — «admin/admin» на машине с проброшенным портом
  // это открытая дверь, а придумать его за владельца мы не можем.
  const password = randomBytes(6).toString('base64url');
  const fresh = makeConfig('admin', password);
  console.log('\n  Админка настроена впервые:');
  console.log(`    логин:  admin`);
  console.log(`    пароль: ${password}`);
  console.log('  Сменить: node tools/admin.mjs --set-password\n');
  return fresh;
}

const checkPassword = (cfg, password) => {
  const a = scryptSync(password, cfg.salt, 64);
  const b = Buffer.from(cfg.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

const sign = (cfg, value) => createHmac('sha256', cfg.secret).update(value).digest('hex');

function issueToken(cfg) {
  const until = String(Date.now() + 30 * DAY);
  return `${until}.${sign(cfg, until)}`;
}

function validToken(cfg, token) {
  const [until, mac] = String(token || '').split('.');
  if (!until || !mac) return false;
  if (Number(until) < Date.now()) return false;
  const expect = sign(cfg, until);
  return mac.length === expect.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
}

const cookieOf = (req, name) => {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};

// Смена пароля из терминала — единственное место, где админка что-то спрашивает.
if (argv.includes('--set-password')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const login = (await rl.question('Логин [admin]: ')).trim() || 'admin';
  const password = (await rl.question('Пароль: ')).trim();
  rl.close();
  if (password.length < 4) {
    console.error('Пароль короче четырёх знаков — так не пойдёт.');
    process.exit(1);
  }
  makeConfig(login, password);
  console.log(`Готово. Вход: ${login}`);
  process.exit(0);
}

const config = loadConfig();

// ==========================================================================
// Ответы
// ==========================================================================

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4',
};

const json = (res, data, code = 200) => {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
};

const fail = (res, message, code = 400) => json(res, { error: message }, code);

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Файл больше 25 МБ — уменьшите его');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const readJSONBody = async (req) => {
  const raw = await readBody(req, 8 * 1024 * 1024);
  return raw.length ? JSON.parse(raw.toString('utf8')) : {};
};

// ==========================================================================
// Картинки
// ==========================================================================
// Те же размеры, что у prepare-product-images.mjs: карточка в сетке живёт
// на 600px, галерея товара на 1000px. fit: 'inside' — кадр не обрезается:
// у товара он может быть какой угодно формы, и кроп срезал бы половину конька.

const WEBP = { quality: 80, alphaQuality: 100 };

async function saveShot(buffer, dest, size) {
  await sharp(buffer)
    .rotate()                                    // развернуть по EXIF: снимки с телефона иначе лягут боком
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp(WEBP)
    .toFile(dest);
}

// Имя кадра с коротким хешем содержимого: заливка нового фото не должна
// подменять уже отданный браузерам файл — иначе у владельца в админке новый
// кадр, а у посетителя из кеша старый.
const shotName = (prefix, buffer) =>
  `${prefix}-${createHash('sha1').update(buffer).digest('hex').slice(0, 8)}.webp`;

// Главный кадр карточки собираем из первого кадра галереи: порядок фото
// владелец меняет перетаскиванием, и «главное» должно ехать за ним само.
async function refreshMain(product) {
  const first = (product.gallery || [])[0];
  if (!first || !existsSync(join(ROOT, first))) {
    product.img = null;
    return;
  }
  const name = `${product.id}.webp`;
  await saveShot(readFileSync(join(ROOT, first)), join(PRODUCT_IMG, name), 600);
  product.img = `assets/img/products/${name}`;
}

// Удаляем только то, что сами и положили: путь обязан лежать внутри assets/img,
// иначе кривой запрос вынес бы что угодно из репозитория.
function removeAsset(rel) {
  if (!rel) return;
  const file = resolve(ROOT, rel);
  const dir = resolve(ROOT, 'assets', 'img');
  if (file !== dir && !file.startsWith(dir + sep)) return;
  try { rmSync(file, { force: true }); } catch {}
}

// ==========================================================================
// Публикация
// ==========================================================================
// Пересборка идёт в фоне, а интерфейс опрашивает состояние: build-products
// пишет 1142 страницы, и держать всё это время открытый запрос незачем.
// Порядок жёсткий — build-catalog кладёт в index.html меню, из которого
// build-products берёт шапку для страниц товаров.

const publish = {
  running: false,
  ok: null,
  startedAt: null,
  finishedAt: null,
  log: [],
};

const say = (line) => {
  publish.log.push(line);
  if (publish.log.length > 400) publish.log.shift();
  console.log(`  ${line}`);
};

// Без shell: путь к node.exe на Windows лежит в «Program Files» с пробелом,
// и оболочка разорвала бы его по пробелу на команду и аргумент.
function run(command, args) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: ROOT });
    const feed = (buf) => String(buf).split('\n').map((s) => s.trimEnd()).filter(Boolean).forEach(say);
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('close', (code) => done(code === 0));
    child.on('error', (e) => { say(`ошибка запуска: ${e.message}`); done(false); });
  });
}

async function startPublish({ push = false } = {}) {
  publish.running = true;
  publish.ok = null;
  publish.startedAt = Date.now();
  publish.finishedAt = null;
  publish.log = [];

  try {
    say('Правим тексты страниц и контакты…');
    let ok = await run(process.execPath, ['tools/build-pages.mjs']);

    say('Готовим данные каталога…');
    const manifest = syncManifest();
    say(`Товаров в каталоге: ${manifest.length}`);

    if (ok) {
      say('Собираем меню, витрину и разделы…');
      ok = await run(process.execPath, ['tools/build-catalog.mjs']);
    }

    if (ok) {
      say('Собираем страницы товаров…');
      ok = await run(process.execPath, ['tools/build-products.mjs']);
    }

    if (ok && push) {
      say('Отправляем на сайт…');
      ok = await run('git', ['add', '-A'])
        && await run('git', ['commit', '-m', 'Правки через админку'])
        && await run('git', ['push']);
    }

    publish.ok = ok;
    say(ok ? 'Готово.' : 'Не получилось — смотрите сообщения выше.');
  } catch (e) {
    publish.ok = false;
    say(`Ошибка: ${e.message}`);
  } finally {
    publish.running = false;
    publish.finishedAt = Date.now();
  }
}

// ==========================================================================
// Данные для интерфейса
// ==========================================================================

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
  const sections = loadSections();
  const count = new Map();
  for (const p of products) {
    const { top } = segments(p.url);
    if (!top) continue;
    if (!count.has(top)) count.set(top, { total: 0, shown: 0 });
    const c = count.get(top);
    c.total++;
    if (!p.hidden && p.img) c.shown++;
  }
  return sections
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .map((s) => ({
      ...s,
      total: count.get(s.key)?.total || 0,
      shown: count.get(s.key)?.shown || 0,
      subs: subsOf(products, s.key),
    }));
}

// ==========================================================================
// API
// ==========================================================================

async function api(req, res, path, query) {
  const cfg = config;
  const authed = validToken(cfg, cookieOf(req, COOKIE));

  // --- вход ---
  if (path === '/api/login' && req.method === 'POST') {
    const { login, password } = await readJSONBody(req);
    if (login !== cfg.login || !checkPassword(cfg, String(password || ''))) {
      return fail(res, 'Неверный логин или пароль', 401);
    }
    res.setHeader('Set-Cookie',
      `${COOKIE}=${issueToken(cfg)}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Lax`);
    return json(res, { ok: true });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
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
    const shown = products.filter((p) => !p.hidden && p.img);
    return json(res, {
      products: products.length,
      shown: shown.length,
      hidden: products.filter((p) => p.hidden).length,
      noPhoto: products.filter((p) => !p.img).length,
      sections: loadSections().length,
      publish: {
        running: publish.running,
        ok: publish.ok,
        finishedAt: publish.finishedAt,
      },
    });
  }

  // --- товары ---
  if (path === '/api/products' && req.method === 'GET') {
    const products = loadProducts();
    const q = (query.get('q') || '').trim().toLowerCase();
    const section = query.get('section') || '';
    const state = query.get('state') || '';       // shown | hidden | nophoto
    const page = Math.max(1, Number(query.get('page') || 1));
    const per = Math.min(200, Number(query.get('per') || 40));

    let list = products;
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
    const sections = loadSections();

    const section = sections.find((s) => s.key === body.section);
    if (!section) return fail(res, 'Не выбран раздел');

    // Новый артикул — следом за самым большим из существующих: адреса товаров
    // строятся из него, и повторный номер увёл бы новый товар на чужую страницу.
    const maxId = products.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
    const id = String(maxId + 1);

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
    const next = body.map((s, i) => ({
      ...current.get(s.key),
      key: s.key,
      name: current.get(s.key)?.name || s.name || s.title,
      title: String(s.title || '').trim() || s.key,
      img: s.img ?? current.get(s.key)?.img ?? null,
      cut: s.cut ?? current.get(s.key)?.cut ?? false,
      hidden: Boolean(s.hidden),
      order: i,
    }));
    saveSections(next);
    return json(res, sectionsWithCounts());
  }

  const sectionPhoto = path.match(/^\/api\/sections\/([^/]+)\/photo$/);
  if (sectionPhoto && req.method === 'POST') {
    const key = decodeURIComponent(sectionPhoto[1]);
    const sections = loadSections();
    const section = sections.find((s) => s.key === key);
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
    // модификатор --raw, иначе фон встанет с полями, как вырезанный.
    section.cut = false;
    saveSections(sections);
    return json(res, sectionsWithCounts());
  }

  // --- контакты ---
  if (path === '/api/site') {
    if (req.method === 'GET') return json(res, loadSite());
    if (req.method === 'PUT') {
      const body = await readJSONBody(req);
      const site = loadSite();
      saveSite({ ...site, ...body });
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

  // Фотография в шапке главной. Кадр подрезаем под ту же форму, что стоит
  // в разметке (2752×1536): у <img> проставлены width и height, и снимок
  // других пропорций поехал бы вместе со всей первой страницей.
  // position: 'attention' — sharp сам выбирает самый «содержательный» кусок,
  // а не геометрический центр, где у портретной съёмки оказывается подбородок.
  if (path === '/api/hero' && req.method === 'POST') {
    const buffer = await readBody(req);
    if (!buffer.length) return fail(res, 'Пустой файл');
    try {
      await sharp(buffer)
        .rotate()
        .resize(2752, 1536, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(join(ROOT, 'assets', 'img', 'hero.jpg'));
    } catch {
      return fail(res, 'Не похоже на фотографию — нужен JPG, PNG или WebP');
    }
    return json(res, { path: 'assets/img/hero.jpg' });
  }

  // Картинка для главной или внутренней страницы: складываем в assets/img/pages/,
  // возвращаем путь — интерфейс подставляет его в нужное поле.
  if (path === '/api/upload' && req.method === 'POST') {
    const buffer = await readBody(req);
    if (!buffer.length) return fail(res, 'Пустой файл');
    mkdirSync(PAGE_IMG, { recursive: true });
    const name = shotName(slug(query.get('name') || 'img') || 'img', buffer);
    const size = Number(query.get('size') || 1600);
    try {
      await saveShot(buffer, join(PAGE_IMG, name), size);
    } catch {
      return fail(res, 'Не похоже на картинку — нужен JPG, PNG или WebP');
    }
    return json(res, { path: `assets/img/pages/${name}` });
  }

  // --- публикация ---
  if (path === '/api/publish' && req.method === 'POST') {
    if (publish.running) return fail(res, 'Публикация уже идёт', 409);
    const body = await readJSONBody(req);
    startPublish({ push: Boolean(body.push) });      // без await: следим через /api/publish
    return json(res, { started: true });
  }

  if (path === '/api/publish') {
    return json(res, {
      running: publish.running,
      ok: publish.ok,
      startedAt: publish.startedAt,
      finishedAt: publish.finishedAt,
      log: publish.log,
    });
  }

  return fail(res, 'Нет такого метода', 404);
}

// ==========================================================================
// Статика: интерфейс админки и сам сайт
// ==========================================================================

function fileFor(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  rel = rel.replace(/\/+/g, '/').replace(/^\//, '');

  const target = resolve(ROOT, rel);
  if (target !== resolve(ROOT) && !target.startsWith(resolve(ROOT) + sep)) return null;

  try {
    const s = statSync(target);
    if (s.isFile()) return target;
    if (s.isDirectory()) {
      const idx = join(target, 'index.html');
      return existsSync(idx) ? idx : null;
    }
  } catch {}
  if (!extname(target)) {
    const idx = join(target, 'index.html');
    if (existsSync(idx)) return idx;
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) return await api(req, res, path, url.searchParams);
  } catch (e) {
    console.error(e);
    return fail(res, e.message || 'Внутренняя ошибка', 500);
  }

  // Интерфейс админки: любой адрес внутри /admin/ отдаёт одну и ту же страницу —
  // разделы переключаются на клиенте, а перезагрузка на /admin/tovary не должна
  // упираться в 404.
  if (path === '/admin' || path === '/admin/') {
    const file = join(ADMIN_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return createReadStream(file).pipe(res);
  }

  const file = fileFor(path);
  if (!file) {
    res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end('<!DOCTYPE html><meta charset="utf-8"><title>404</title>'
      + `<body style="font:16px system-ui;padding:40px"><h1>404</h1><p>Не найдено: ${path}</p>`);
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Админка:  http://${HOST}:${PORT}/admin/`);
  console.log(`  Сайт:     http://${HOST}:${PORT}/`);
  console.log('  Ctrl+C — остановить\n');
});
