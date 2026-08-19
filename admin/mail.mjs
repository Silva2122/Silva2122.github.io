// Отправка заказов из корзины на почту.
//
// Настройки лежат в content/.smtp.json (в .gitignore — там пароль приложения
// почтового ящика). Файла нет ни в репозитории, ни при первом разворачивании
// сервера — заводится руками, как и content/.admin.json.
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { CONTENT, readJSON } from '../tools/content.mjs';

const CONFIG = join(CONTENT, '.smtp.json');

let cfg;
function config() {
  if (cfg === undefined) {
    const loaded = readJSON(CONFIG, null);
    cfg = loaded?.host && loaded?.user && loaded?.pass ? loaded : null;
  }
  return cfg;
}

let transporter = null;
function transport(c) {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: c.host,
      port: c.port || 465,
      secure: c.secure !== false,
      auth: { user: c.user, pass: c.pass },
      // Дефолт nodemailer — две минуты: покупатель столько ждать не будет,
      // а nginx впереди сбрасывает соединение раньше (proxy_read_timeout 60с),
      // и ответ с ошибкой до браузера всё равно не доехал бы. Быстрый таймаут
      // укладывается в это окно и даёт покупателю понятную ошибку вовремя.
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 8000,
    });
  }
  return transporter;
}

export const mailConfigured = () => Boolean(config());

export async function sendOrderMail({ subject, text }) {
  const c = config();
  if (!c) throw new Error('Почта не настроена');
  await transport(c).sendMail({
    from: `Аксель·НН <${c.user}>`,
    to: c.to || c.user,
    subject,
    text,
  });
}
