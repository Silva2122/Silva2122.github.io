// Текстовые слоты страниц: что владелец правит в разделе «Страницы».
//
// Вёрстка внутренних страниц набрана руками и живёт в HTML — переносить её
// в JSON ради админки означало бы переписать семь страниц и потерять всё,
// что в них есть кроме текста: карточки услуг, таблицы, блоки с фактами.
// Поэтому правится не страница целиком, а её текстовые места: заголовки,
// лид, абзацы, пункты списков, подписи фактов.
//
// Слот опознаётся не позицией, а хешем собственного текста. Позиция сползает
// от любой правки вёрстки, и правка «второй абзац» уехала бы в чужой абзац;
// хеш же говорит ровно «тот кусок, где было написано вот это». Не нашли —
// правку не применяем и пишем об этом в лог, а не портим страницу молча.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { plain } from './typo.mjs';
import { ROOT } from './content.mjs';

// Что считаем текстом. Порядок важен: правила проверяются сверху вниз,
// и вложенные совпадения отсеиваются по позиции — из <div class="fact__value">
// с вложенным <span class="fact__note"> берутся оба, но по отдельности.
const RULES = [
  { label: 'Заголовок страницы', re: /(<h1 class="page-title">)([\s\S]*?)(<\/h1>)/g },
  { label: 'Подзаголовок страницы', re: /(<p class="page-lead">)([\s\S]*?)(<\/p>)/g },
  { label: 'Заголовок героя', re: /(<h1 class="hero__title">)([\s\S]*?)(<\/h1>)/g },
  { label: 'Кнопка героя', re: /(<a href="[^"]*" class="hero__cta">)([^<]*)(<svg)/g },
  { label: 'Бегущая строка', re: /(<\/svg>)([^<]+)(<\/span>)/g },
  { label: 'Заголовок блока', re: /(<h2 class="section-title">)([\s\S]*?)(<\/h2>)/g },
  { label: 'Надзаголовок слайда', re: /(<span class="promo__eyebrow">)([\s\S]*?)(<\/span>)/g },
  { label: 'Заголовок слайда', re: /(<h2 class="promo__title">)([\s\S]*?)(<\/h2>)/g },
  { label: 'Текст слайда', re: /(<p class="promo__text">)([\s\S]*?)(<\/p>)/g },
  { label: 'Название категории', re: /(<div class="category__name">)([\s\S]*?)(<\/div>)/g },
  { label: 'Подзаголовок', re: /(<h2>)([\s\S]*?)(<\/h2>)/g },
  { label: 'Подзаголовок', re: /(<h3>)([\s\S]*?)(<\/h3>)/g },
  { label: 'Подпись', re: /(<span class="fact__label">)([\s\S]*?)(<\/span>)/g },
  // Значение факта — до вложенного пояснения: адрес и режим работы лежат
  // текстом прямо в контейнере, а <span class="fact__note"> идёт следом.
  { label: 'Значение', re: /(<div class="fact__value">)([\s\S]*?)(<span class="fact__note">|<\/div>)/g },
  { label: 'Пояснение', re: /(<span class="fact__note">)([\s\S]*?)(<\/span>)/g },
  { label: 'Абзац', re: /(<p[^>]*>)([\s\S]*?)(<\/p>)/g },
  { label: 'Пункт списка', re: /(<li[^>]*>)([\s\S]*?)(<\/li>)/g },
];

// Границы редактируемой зоны. Шапка и подвал общие: их источник — index.html,
// и правятся они там же, иначе правка на одной странице разошлась бы
// с остальными на первой же пересборке.
const ZONES = {
  home: ['<!-- ГЕРОЙ -->', '<!-- ПОДВАЛ -->'],
  inner: ['<!-- ШАПКА СТРАНИЦЫ -->', '<!-- ПОДВАЛ -->'],
  footer: ['<!-- ОБЩЕЕ:ПОДВАЛ:НАЧАЛО -->', '<!-- ОБЩЕЕ:ПОДВАЛ:КОНЕЦ -->'],
};

export const keyOf = (text) => createHash('sha1').update(plain(text)).digest('hex').slice(0, 10);

// --- какие страницы вообще правятся ---------------------------------------
// Генерируемые пропускаем: их собирают build-catalog и build-products из
// данных, и правка текста в них исчезла бы на первой же пересборке.
const SKIP_DIRS = new Set([
  'node_modules', 'old_version', 'tools', 'admin', 'content',
  'catalog', 'cart', 'favorites',
]);

export function sitePages(dir = ROOT, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sitePages(p, acc);
    else if (e.name.endsWith('.html')) acc.push(relative(ROOT, p).replace(/\\/g, '/'));
  }
  return acc;
}

// Зоны правки: у главной свои секции плюс подвал, который отсюда разъедется
// по всему сайту; у внутренних страниц — их содержимое.
export const zonesFor = (file) => (file === 'index.html' ? ['home', 'footer'] : ['inner']);

// Имя страницы для списка в админке: заголовок из разметки понятнее адреса.
export const pageTitle = (file, html) =>
  file === 'index.html'
    ? 'Главная страница'
    : plain(html.match(/<h1 class="page-title">([\s\S]*?)<\/h1>/)?.[1] || '')
      || plain(html.match(/<title>([^<]*)<\/title>/)?.[1] || '').split('—')[0].trim()
      || file;

function zoneRange(html, zone) {
  const [from, to] = ZONES[zone];
  const a = html.indexOf(from);
  if (a === -1) return null;
  const b = html.indexOf(to, a);
  return { start: a, end: b === -1 ? html.length : b };
}

/**
 * Все текстовые слоты страницы.
 * @returns {Array<{key, label, text, raw, start, end}>} в порядке появления
 */
export function slotsOf(html, zones) {
  const ranges = zones.map((z) => zoneRange(html, z)).filter(Boolean);
  if (!ranges.length) return [];

  const found = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(html))) {
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      if (!ranges.some((r) => start >= r.start && end <= r.end)) continue;
      const text = plain(m[2]);
      // Пустое и чисто служебное (одна иконка, один пробел) не показываем:
      // в списке полей это были бы строки без содержания.
      if (text.length < 2 || /^<[^>]+>$/.test(m[2].trim())) continue;
      // Кусок, целиком состоящий из ссылок, — это телефон, почта или пара
      // кнопок. Их значение правится в «Контактах», а тут владелец увидел бы
      // сырую разметку и правил бы вслепую.
      if (/^(\s*<a\b[^>]*>[^<]*<\/a>\s*)+$/.test(m[2].trim())) continue;
      found.push({ label: rule.label, raw: m[2], text, start, end });
    }
  }

  // Вложенные куски выкидываем: <div class="fact__value"> целиком включает
  // в себя <span class="fact__note">, и править их обоими полями нельзя —
  // одно затрёт другое.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const flat = [];
  for (const slot of found) {
    const parent = flat[flat.length - 1];
    if (parent && slot.start < parent.end) continue;
    flat.push(slot);
  }

  const seen = new Map();
  return flat.map((slot) => {
    // Один и тот же текст встречается дважды (в бегущей строке — намеренно,
    // там вторая лента дублирует первую). Ключ у них общий, и правка
    // применится к обоим — это ровно то поведение, которое нужно.
    const key = keyOf(slot.text);
    seen.set(key, (seen.get(key) || 0) + 1);
    return { ...slot, key, copies: seen.get(key) };
  });
}

/**
 * Применяет правки к разметке. Возвращает новый html и отчёт:
 * какие правки легли, какие не нашли своего места.
 * @param {Record<string, {was: string, text: string}>} edits
 */
export function applyEdits(html, zones, edits, render) {
  const slots = slotsOf(html, zones);
  const applied = new Set();
  let out = html;

  // Идём с конца: замена сдвигает всё, что правее, и позиции слотов слева
  // остаются верными только при обратном порядке.
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    const edit = edits[slot.key];
    if (!edit) continue;
    // was — страховка от совпадения хешей и от правки, набранной когда-то
    // для другого текста: применяем, только если на месте лежит то же, что
    // владелец видел в поле.
    if (edit.was != null && plain(edit.was) !== slot.text) continue;
    out = out.slice(0, slot.start) + render(edit.text) + out.slice(slot.end);
    applied.add(slot.key);
  }

  const missed = Object.keys(edits).filter((k) => !applied.has(k));
  return { html: out, applied: [...applied], missed };
}

export { ZONES };
