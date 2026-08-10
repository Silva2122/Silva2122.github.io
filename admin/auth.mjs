// Вход в админку: пароль, кука, смена пароля из терминала.
//
// Пароль храним не сам, а scrypt-хеш с солью: файл настроек лежит рядом
// с сайтом, и пароль из него не должен читаться глазами. Куку подписываем
// HMAC вместо списка сессий в памяти — иначе перезапуск сервера выкидывал бы
// владельца из админки посреди правки.
//
// content/.admin.json в .gitignore: там и хеш, и ключ подписи.
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { ROOT, readJSON, writeJSON } from '../tools/content.mjs';

export const COOKIE = 'axelnn_admin';
export const TTL_DAYS = 30;

const CONFIG = join(ROOT, 'content', '.admin.json');
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

export function loadConfig() {
  const cfg = readJSON(CONFIG, null);
  if (cfg?.hash) return cfg;
  // Первый запуск: заводим вход и печатаем его в консоль. Пароль случайный —
  // «admin/admin» на машине с проброшенным портом это открытая дверь,
  // а придумать его за владельца мы не можем.
  const password = randomBytes(6).toString('base64url');
  const fresh = makeConfig('admin', password);
  console.log('\n  Админка настроена впервые:');
  console.log('    логин:  admin');
  console.log(`    пароль: ${password}`);
  console.log('  Сменить: node admin/server.mjs --set-password\n');
  return fresh;
}

export const checkPassword = (cfg, password) => {
  const a = scryptSync(password, cfg.salt, 64);
  const b = Buffer.from(cfg.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

const sign = (cfg, value) => createHmac('sha256', cfg.secret).update(value).digest('hex');

export function issueToken(cfg) {
  const until = String(Date.now() + TTL_DAYS * DAY);
  return `${until}.${sign(cfg, until)}`;
}

export function validToken(cfg, token) {
  const [until, mac] = String(token || '').split('.');
  if (!until || !mac) return false;
  if (Number(until) < Date.now()) return false;
  const expect = sign(cfg, until);
  return mac.length === expect.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
}

// За обратным прокси (nginx) TLS оканчивается перед Node, и сам сокет
// «незашифрованный» — HTTPS выдаёт только заголовок от прокси.
export const secureCookie = (req) =>
  req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';

export const cookieOf = (req, name) => {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};

// Единственное место, где админка о чём-то спрашивает в терминале.
export async function setPassword() {
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
}
