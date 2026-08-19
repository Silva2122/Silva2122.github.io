// Применяет к страницам сайта правки текста и контактов из content/.
//
//   node tools/build-pages.mjs          применить
//   node tools/build-pages.mjs --dry    показать, ничего не записывая
//
// Запускать первым — до build-catalog.mjs: подвал и шапка живут в index.html,
// а по остальным страницам их разносит именно он. Поменяли телефон здесь —
// он уедет во все 1142 страницы товаров только следующим шагом конвейера.
//
// Правки текста приезжают из content/pages.json и после применения оттуда
// исчезают: правда о тексте лежит в самой странице, а pages.json — очередь
// того, что владелец наменял с прошлой публикации. Так админка всегда
// показывает актуальный текст, а не расходится с сайтом.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadPages, savePages, loadSite, digits } from './content.mjs';
import { slotsOf, applyEdits, sitePages, zonesFor } from './pages.mjs';
import { typo } from './typo.mjs';

const DRY = process.argv.includes('--dry');

// --- контакты -------------------------------------------------------------
// Телефон и почта повторяются в шапке, подвале и на «Контактах» — и в тексте,
// и в ссылке. Ищем их по маске, а не по прошлому значению: прошлое пришлось бы
// где-то хранить, и первая же правка руками рассинхронизировала бы таблицу.

function applyContacts(html, site) {
  let out = html;

  if (site.phone) {
    out = out
      .replace(/href="tel:[^"]*"/g, `href="tel:${digits(site.phone)}"`)
      // Текст ссылки: там, где он и есть сам телефон («+7 831…»), берём его
      // целиком по границам тега <a href="tel:…">…</a>, а не по маске «похоже
      // на телефон, и сразу за ним идёт <» — та однажды не смогла дочистить
      // склеенные два номера (см. историю коммита), потому что цепляла только
      // хвост вплотную к закрывающему тегу. У части ссылок в тексте кнопки
      // стоит не номер, а подпись («Позвонить») — такие не трогаем: проверяем,
      // что текущий текст начинается с «+», прежде чем стирать его целиком.
      .replace(/(<a[^>]*href="tel:[^"]*"[^>]*>)([^<]*)(<\/a>)/g, (m, open, body, close) =>
        /^\s*\+/.test(body) ? `${open}${site.phone}${close}` : m);
  }

  if (site.email) {
    out = out
      // Хвост после адреса сохраняем: у кнопки «Отправить резюме» в mailto
      // стоит ?subject=…, и замена ссылки целиком стирала тему письма.
      .replace(/href="mailto:[^"?]*([^"]*)"/g, `href="mailto:${site.email}$1"`)
      // Текст ссылки — та же логика, что у телефона: заменяем целиком, но
      // только там, где он и есть сам адрес (содержит «@»), не трогая кнопки
      // с подписью вроде «Отправить резюме».
      .replace(/(<a[^>]*href="mailto:[^"]*"[^>]*>)([^<]*)(<\/a>)/g, (m, open, body, close) =>
        body.includes('@') ? `${open}${site.email}${close}` : m);
  }

  // Соцсети — ссылки подряд внутри контейнера, порядок в разметке фиксирован.
  const socialLinks = (html, className, links) => {
    if (!links.some(Boolean)) return html;
    let i = 0;
    const re = new RegExp(`(<div class="${className}">)([\\s\\S]*?)(<\\/div>)`, 'g');
    return html.replace(re, (all, open, body, close) =>
      open + body.replace(/href="[^"]*"/g, () => {
        const href = links[i++] || '';
        return href ? `href="${href}"` : 'href="#"';
      }) + close);
  };

  out = socialLinks(out, 'footer__social', [site.vk, site.telegram]);
  // Баннеры «Мы в Telegram / Мы в Instagram» — только на главной, но
  // регулярка просто не найдёт .socials на остальных страницах и не тронет их.
  out = socialLinks(out, 'socials', [site.telegram, site.instagram]);

  return out;
}

// --- прогон ---------------------------------------------------------------

const site = loadSite();
const pages = loadPages();
const files = sitePages();

let touched = 0;
const leftovers = {};

console.log('Страницы:');

for (const file of files) {
  const path = join(ROOT, file);
  const before = readFileSync(path, 'utf8');
  const edits = pages[file]?.edits || {};

  const { html, applied, missed } = applyEdits(before, zonesFor(file), edits, typo);
  const after = applyContacts(html, site);

  if (missed.length) {
    // Правка не нашла своего места: текст на странице изменился с тех пор,
    // как её набрали. Оставляем в очереди и говорим вслух — молча потерянная
    // правка выглядит как «админка не работает».
    leftovers[file] = { edits: Object.fromEntries(missed.map((k) => [k, edits[k]])) };
    console.log(`  ⚠ ${file}: ${missed.length} правок не нашли своё место на странице`);
  }

  if (after === before) {
    if (applied.length) console.log(`  без изменений: ${file}`);
    continue;
  }

  if (!DRY) writeFileSync(path, after, 'utf8');
  touched++;
  console.log(`  ${DRY ? '[dry] ' : ''}${file}: ${applied.length ? `правок ${applied.length}` : 'контакты'}`);
}

// Применённое из очереди убираем: дальше правда о тексте живёт в самой странице.
if (!DRY) savePages(leftovers);

const slots = files.reduce((n, f) => n + slotsOf(readFileSync(join(ROOT, f), 'utf8'), zonesFor(f)).length, 0);
console.log(`\nОбновлено страниц: ${touched} из ${files.length}. Мест для правки текста: ${slots}`);
