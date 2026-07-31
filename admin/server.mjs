// Админка сайта — точка входа.
//
//   node admin/server.mjs                  http://127.0.0.1:4180/admin/
//   node admin/server.mjs --port 4180
//   node admin/server.mjs --set-password   сменить логин и пароль
//   node admin/server.mjs --host 0.0.0.0   пустить в сеть (только за HTTPS!)
//
// Сайт статический, бэкенда у него нет и не будет: страницы собираются
// генераторами и лежат файлами. Поэтому админка — не «движок сайта», а
// редактор его исходников: правит content/*.json и кадры в assets/img/,
// а по кнопке «Опубликовать» гоняет те же скрипты из tools/, что и мы руками.
//
// Отсюда два следствия. Первое: между правкой и её появлением на сайте есть
// шаг публикации — как между «сохранил файл» и «залил». Второе: на хостинг
// переезжает эта же папка целиком, менять в ней ничего не придётся.
//
// Модуль замкнут в admin/: сервер, API, вход, картинки, публикация, интерфейс
// в ui/. Наружу торчат только два импорта — tools/content.mjs (данные сайта)
// и tools/pages.mjs (текстовые слоты страниц), потому что тем же самым
// пользуются генераторы, и второй копии этих правил быть не должно.
//
// Раздаёт сервер и сам сайт (тот же корень), чтобы результат правки можно
// было посмотреть в соседней вкладке, не поднимая serve.mjs отдельно.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { ROOT } from '../tools/content.mjs';
import { MIME, fail } from './http.mjs';
import { loadConfig, setPassword } from './auth.mjs';
import { api } from './api.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 4180));
const HOST = arg('--host', '127.0.0.1');

const UI = join(ROOT, 'admin', 'ui');

if (argv.includes('--set-password')) {
  await setPassword();
  process.exit(0);
}

const config = loadConfig();

// --- статика --------------------------------------------------------------

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

// Всё внутри /admin/ ищется только в admin/ui/ — и адрес остаётся коротким,
// и серверные модули по HTTP не отдаются: admin/api.mjs не должен выкачиваться
// как обычный файл сайта.
function adminFile(pathname) {
  const rel = pathname.replace(/^\/admin\/?/, '');
  // Пустой адрес и любой раздел интерфейса (#/products уже на клиенте, но
  // /admin/что-угодно тоже не должно давать 404) отдают одну и ту же страницу.
  if (!rel || !extname(rel)) return join(UI, 'index.html');
  const target = resolve(UI, rel);
  if (!target.startsWith(resolve(UI) + sep)) return null;
  return existsSync(target) ? target : null;
}

const send = (res, file) => {
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (path.startsWith('/api/')) return await api(req, res, path, url.searchParams, config);
  } catch (e) {
    console.error(e);
    return fail(res, e.message || 'Внутренняя ошибка', 500);
  }

  const file = path === '/admin' || path.startsWith('/admin/')
    ? adminFile(path)
    : fileFor(path);

  if (!file) {
    res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return res.end('<!DOCTYPE html><meta charset="utf-8"><title>404</title>'
      + `<body style="font:16px system-ui;padding:40px"><h1>404</h1><p>Не найдено: ${path}</p>`);
  }

  send(res, file);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Админка:  http://${HOST}:${PORT}/admin/`);
  console.log(`  Сайт:     http://${HOST}:${PORT}/`);
  console.log('  Ctrl+C — остановить\n');
});
