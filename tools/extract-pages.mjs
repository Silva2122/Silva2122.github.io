// Вытаскивает контентную область информационных страниц из зеркала old_version/site.
// У Aspro текст страницы лежит в <div class="container"> внутри .middle — всё остальное
// (шапка, левое меню, баннеры, подвал) отбрасываем.
//
// Запуск: node tools/extract-pages.mjs [> куда-нибудь.md]

import { readFileSync, existsSync } from 'node:fs';

// Windows-путь из import.meta.url: срезаем ведущий слэш у /C:/...
const root = new URL('../old_version/site/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const PAGES = [
  'company/index.html',
  'company/licenses/index.html',
  'company/rekvizity/index.html',
  'company/reviews/index.html',
  'company/vacancy/index.html',
  'contacts/index.html',
  // 'contacts/stores/index.html' — партнёров на новом сайте нет: заказчик
  // оставил один адрес, Бетанкура, 6. Страницу не переносим.
  'help/index.html',
  'help/delivery/index.html',
  'help/payment/index.html',
  'help/warranty/index.html',
  'info/index.html',
  'info/brands/index.html',
  'info/faq/index.html',
  'services/index.html',
];

// Вырезает содержимое блока с балансировкой вложенных <div>, начиная от позиции open.
function sliceBlock(html, open) {
  let depth = 0;
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = open;
  let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  return html.slice(open);
}

function extract(html) {
  const mid = html.indexOf('<div class="middle ">');
  if (mid === -1) return null;
  const block = sliceBlock(html, mid);
  const c = block.indexOf('<div class="container">');
  return c === -1 ? block : sliceBlock(block, c);
}

function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<(br|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(+n) + ' ')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(s => s.trim()).filter(Boolean).join('\n');
}

for (const p of PAGES) {
  const file = root + p;
  if (!existsSync(file)) { console.log(`\n\n===== ${p} — НЕТ ФАЙЛА =====`); continue; }
  const html = readFileSync(file, 'utf8');
  const title = (html.match(/<title>([^<]*)/) || [, ''])[1].trim();
  const body = extract(html);
  console.log(`\n\n========================================`);
  console.log(`=== ${p}  |  ${title}`);
  console.log(`========================================`);
  console.log(body ? toText(body) : '(контент не найден)');
}
