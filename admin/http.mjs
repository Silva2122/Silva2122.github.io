// Мелочи HTTP, общие для сервера и API: типы, ответы, чтение тела.
// Ничего специфичного для админки здесь нет — только то, что в node:http
// приходится писать руками на каждом обработчике.

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4',
};

export const json = (res, data, code = 200) => {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

// Текст ошибки идёт прямо в интерфейс, поэтому он на русском и по делу:
// владелец должен понять, что делать, а не искать код состояния в справочнике.
export const fail = (res, message, code = 400) => json(res, { error: message }, code);

export async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`Файл больше ${Math.round(limit / 1024 / 1024)} МБ — уменьшите его`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const readJSONBody = async (req) => {
  const raw = await readBody(req, 8 * 1024 * 1024);
  return raw.length ? JSON.parse(raw.toString('utf8')) : {};
};
