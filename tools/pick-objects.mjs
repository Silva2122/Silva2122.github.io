// Отбирает «чистую предметку» — фото товара без людей в кадре.
//
// Одного фильтра по разделу мало. В «Аксессуарах для льда» перчатка надета на руку,
// в «Тренажёрах» рядом стоит человек, а вырезанный по контуру человек в карточке
// товара смотрится как чужой кадр: предмет теряется на фоне модели. Поэтому поверх
// категорий гоняем детектор объектов и выкидываем всё, где нашёлся person.
//
//   node tools/pick-objects.mjs              полный отбор
//   node tools/pick-objects.mjs --limit 40   быстрая проверка на выборке
//
// Результат: old_version/_objects.json — список для remove-bg.mjs --from objects
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');
const SITE = join(ROOT, 'old_version', 'site');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', 0));
const SCORE = Number(arg('--score', 0.6));   // порог уверенности детектора

// Разделы, где товар снимают отдельно от человека. «Одежду» и «Защиту фигуриста»
// не берём целиком: там модель в кадре — норма, их прогоняем отдельной пачкой.
//
// Сравниваем через norm(): в каталоге соседствуют «Тренажёры» и «Тренажеры»,
// и точное совпадение молча теряет 33 карточки.
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const OBJECT_CATS = new Set([
  'Аксессуары для льда',
  'Хранение',
  'Сувениры',
  'Сумки,рюкзаки',
  'Тренажёры',
  'Мешки для обуви',
  'Фигурные коньки',
  'Лезвия',
  'Ботинки для фигурного катания',
].map(norm));

// Классы COCO, из-за которых кадр уходит в «с людьми».
const HUMAN = new Set(['person']);

const q = JSON.parse(readFileSync(join(ROOT, 'old_version', '_image-quality.json'), 'utf8'));
const pool = [...q.bad, ...q.mid, ...q.studio].filter((it) => OBJECT_CATS.has(norm(it.cat)));
const list = LIMIT ? pool.slice(0, LIMIT) : pool;

console.log(`Кандидатов по разделам: ${pool.length}${LIMIT ? ` (беру ${list.length})` : ''}`);
console.log('Загружаю детектор...');

const { pipeline } = await import('@huggingface/transformers');
const detector = await pipeline('object-detection', 'Xenova/detr-resnet-50', { dtype: 'fp32' });
console.log('Готово\n');

const clean = [], withPeople = [], failed = [];

for (const [i, it] of list.entries()) {
  const src = join(SITE, it.img.replace(/^\//, '').replace(/\//g, '\\'));
  try {
    const found = await detector(src, { threshold: SCORE });
    const people = found.filter((f) => HUMAN.has(f.label));
    const labels = [...new Set(found.map((f) => f.label))].slice(0, 4).join(', ') || '—';

    if (people.length) {
      const top = Math.max(...people.map((p) => p.score));
      withPeople.push({ ...it, personScore: +top.toFixed(2), labels });
      console.log(`  [${i + 1}/${list.length}] ✗ человек ${(top * 100).toFixed(0)}%  ${it.name.slice(0, 32)}  (${labels})`);
    } else {
      clean.push({ ...it, labels });
      console.log(`  [${i + 1}/${list.length}] ✓ ${it.name.slice(0, 38)}  (${labels})`);
    }
  } catch (e) {
    failed.push({ ...it, error: e.message });
    console.log(`  [${i + 1}/${list.length}] ошибка: ${e.message.slice(0, 60)}`);
  }
}

writeFileSync(join(ROOT, 'old_version', '_objects.json'),
  JSON.stringify({ objects: clean, people: withPeople, failed }, null, 2), 'utf8');

console.log(`\nЧистая предметка : ${clean.length}`);
console.log(`Отсеяно (люди)   : ${withPeople.length}`);
if (failed.length) console.log(`Не прочиталось   : ${failed.length}`);

const byCat = {};
for (const it of clean) byCat[it.cat] = (byCat[it.cat] || 0) + 1;
console.log('\nЧистых по разделам:');
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(32)} ${String(n).padStart(4)}`);
}
console.log('\nСписок: old_version/_objects.json');
