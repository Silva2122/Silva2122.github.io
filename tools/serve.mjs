// Локальный статический сервер. Python в системе нет, поэтому свой на node:http.
//
// Умеет два режима:
//   node tools/serve.mjs                    новый сайт (корень репозитория), порт 4173
//   node tools/serve.mjs --root old_version/site --port 8080   копия старого сайта
//
// И главное — экспортирует startServer() для shot.mjs/audit.mjs: те поднимают сервер
// внутри своего процесса на случайном порту и гарантированно гасят его в finally.
// Внешний процесс на Windows оставляет сирот и гоняется за занятым портом.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Путь из import.meta.url на Windows приезжает как /C:/... — срезаем ведущий слэш.
// Тот же хелпер, что в crawl.mjs / extract-products.mjs.
const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

async function statOrNull(p) {
  try { return await stat(p); } catch { return null; }
}

// URL -> файл на диске. Директория и «чистый» адрес разрешаются в index.html.
async function resolveFile(root, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  rel = rel.replace(/\/+/g, '/').replace(/^\//, '');

  const target = resolve(root, rel);
  // защита от выхода за корень через ../
  if (target !== root && !target.startsWith(root + sep)) return null;

  const s = await statOrNull(target);
  if (s?.isFile()) return target;
  if (s?.isDirectory()) {
    const idx = join(target, 'index.html');
    return (await statOrNull(idx))?.isFile() ? idx : null;
  }
  // /catalog/skates -> /catalog/skates/index.html
  if (!extname(target)) {
    const idx = join(target, 'index.html');
    if ((await statOrNull(idx))?.isFile()) return idx;
    const html = target + '.html';
    if ((await statOrNull(html))?.isFile()) return html;
  }
  return null;
}

/**
 * Поднимает сервер и ждёт готовности.
 * @param {{root?: string, port?: number, quiet?: boolean}} opts
 *        port: 0 — ОС сама выдаст свободный (так делают shot.mjs и audit.mjs)
 * @returns {Promise<{url: string, port: number, root: string, close: () => Promise<void>}>}
 */
export function startServer({ root = base('..'), port = 0, quiet = false } = {}) {
  const ROOT = resolve(root);

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = await resolveFile(ROOT, pathname);

    if (!file) {
      if (!quiet) console.log(`  404  ${pathname}`);
      res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(`<!DOCTYPE html><meta charset="utf-8"><title>404</title>
        <body style="font:16px system-ui;padding:40px"><h1>404</h1><p>Не найдено: ${pathname}</p>`);
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      // Без no-store скриншот покажет вчерашний CSS, и правки будут «не применяться».
      'Cache-Control': 'no-store, must-revalidate',
    });
    createReadStream(file).pipe(res);
  });

  return new Promise((ok, err) => {
    server.on('error', err);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      ok({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        root: ROOT,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// --- CLI ---
// Запущен напрямую, а не импортирован. pathToFileURL нормализует диск и слэши сам;
// argv[1] отсутствует при `node -e`, поэтому проверяем.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };

  const root = resolve(base('..'), arg('--root', '.'));
  const port = Number(arg('--port', 4173));

  const { url } = await startServer({ root, port });
  console.log(`Сервер: ${url}`);
  console.log(`Корень: ${root}`);
  console.log('Ctrl+C — остановить');
}
