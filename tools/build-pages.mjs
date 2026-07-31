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
import { ROOT, loadPages, savePages, loadSite } from './content.mjs';
import { slotsOf, applyEdits, sitePages, zonesFor } from './pages.mjs';
import { typo } from './typo.mjs';

const DRY = process.argv.includes('--dry');

// --- контакты -------------------------------------------------------------
// Телефон и почта повторяются в шапке, подвале и на «Контактах» — и в тексте,
// и в ссылке. Ищем их по маске, а не по прошлому значению: прошлое пришлось бы
// где-то хранить, и первая же правка руками рассинхронизировала бы таблицу.

const digits = (s) => String(s || '').replace(/[^\d+]/g, '');

function applyContacts(html, site) {
  let out = html;

  if (site.phone) {
    out = out
      .replace(/href="tel:[^"]*"/g, `href="tel:${digits(site.phone)}"`)
      // Текст ссылки: телефон набран как «+7 831 423-47-96» и стоит между тегами.
      .replace(/(>)\s*\+7[\s\-()\d]{9,}\s*(<)/g, `$1${site.phone}$2`);
  }

  if (site.email) {
    out = out
      // Хвост после адреса сохраняем: у кнопки «Отправить резюме» в mailto
      // стоит ?subject=…, и замена ссылки целиком стирала тему письма.
      .replace(/href="mailto:[^"?]*([^"]*)"/g, `href="mailto:${site.email}$1"`)
      .replace(/(>)\s*[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\s*(<)/gi, `$1${site.email}$2`);
  }

  // Соцсети — две ссылки подряд в подвале, порядок в разметке фиксирован.
  if (site.vk || site.telegram) {
    const links = [site.vk, site.telegram];
    let i = 0;
    out = out.replace(/(<div class="footer__social">)([\s\S]*?)(<\/div>)/g, (all, open, body, close) =>
      open + body.replace(/href="[^"]*"/g, () => {
        const href = links[i++] || '';
        return href ? `href="${href}"` : 'href="#"';
      }) + close);
  }

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
