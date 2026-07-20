// Вырезает фон у фотографий товаров и приводит их к единому виду.
//
// Донорские снимки сняты на телефон в интерьере: бетонная стена, деревянные доски,
// тени, иногда рука в кадре. Порогом по цвету такой фон не берётся — белый ботинок
// на светло-сером бетоне почти не отличается от фона. Поэтому сегментируем моделью
// (ONNX через transformers.js), а дальше sharp: обрезка по предмету, единый холст,
// одинаковые поля. Без этого шага товары повиснут в пустоте разного масштаба.
//
//   node tools/remove-bg.mjs --from bad --n 12        пилот на пёстрых фонах
//   node tools/remove-bg.mjs --from bad --n 12 --model birefnet
//   node tools/remove-bg.mjs --file /upload/iblock/04a/04af....jpg
//
// Результат: .shots/nobg/<модель>/ — PNG с прозрачностью + _report.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');
const SITE = join(ROOT, 'old_version', 'site');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const FROM = arg('--from', 'bad');
const N = Number(arg('--n', 12));
const FILE = arg('--file', null);
const MODEL_KEY = arg('--model', 'rmbg');
const SIZE = Number(arg('--size', 1000));   // сторона итогового квадрата
const PAD = Number(arg('--pad', 0.06));     // поля вокруг предмета, доля стороны
// PNG с альфой на таком размере весит под мегабайт — 336 карточек дают 300 МБ.
// WebP держит прозрачность и жмёт то же самое примерно в десять раз.
const FORMAT = arg('--format', 'webp');
const QUALITY = Number(arg('--quality', 86));

// Маску все три отдают одним каналом, но входной тензор у каждой зовётся по-своему:
// подашь под чужим именем — onnxruntime ответит «Missing the following inputs».
const MODELS = {
  rmbg: { id: 'briaai/RMBG-1.4', input: 'input', note: 'лицензия только для некоммерческого использования' },
  birefnet: { id: 'onnx-community/BiRefNet_lite', input: 'input_image', note: 'MIT' },
  modnet: { id: 'Xenova/modnet', input: 'input', note: 'Apache-2.0' },
};
const MODEL = MODELS[MODEL_KEY];
if (!MODEL) { console.error(`Неизвестная модель: ${MODEL_KEY}. Есть: ${Object.keys(MODELS).join(', ')}`); process.exit(1); }

// ── выборка ──────────────────────────────────────────────────────────────────
let items;
if (FILE) {
  items = [{ name: basename(FILE), cat: '—', img: FILE }];
} else {
  // objects — отбор из pick-objects.mjs: только предметные разделы и без людей в кадре.
  // Остальные группы (bad/mid/studio) — сырая разбивка по однородности фона.
  const file = FROM === 'objects' ? '_objects.json' : '_image-quality.json';
  const q = JSON.parse(readFileSync(join(ROOT, 'old_version', file), 'utf8'));
  const pool = q[FROM];
  if (!pool) { console.error(`Нет группы "${FROM}" в ${file}. Есть: ${Object.keys(q).join(', ')}`); process.exit(1); }

  // Берём вперемешку по разделам, иначе вся выборка окажется из одной категории
  // (в bad сотня «Одежды для девочек») и мы не увидим, как модель ведёт себя
  // на чехлах, коньках и сувенирах.
  const byCat = new Map();
  for (const it of pool) {
    if (!byCat.has(it.cat)) byCat.set(it.cat, []);
    byCat.get(it.cat).push(it);
  }
  items = [];
  const cats = [...byCat.values()];
  for (let r = 0; items.length < N; r++) {
    let added = false;
    for (const list of cats) {
      if (items.length >= N) break;
      if (list[r]) { items.push(list[r]); added = true; }
    }
    if (!added) break;
  }
}

console.log(`Модель : ${MODEL.id}  (${MODEL.note})`);
console.log(`Кадров : ${items.length}\n`);

// ── загрузка модели ──────────────────────────────────────────────────────────
const { AutoModel, AutoProcessor, RawImage } = await import('@huggingface/transformers');
const sharp = (await import('sharp')).default;

console.log('Загружаю модель (первый раз — качает веса, дальше из кэша)...');
const t0 = Date.now();
const model = await AutoModel.from_pretrained(MODEL.id, { dtype: 'fp32' });
const processor = await AutoProcessor.from_pretrained(MODEL.id);
console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(1)} с\n`);

const OUT = join(ROOT, '.shots', 'nobg', MODEL_KEY);
mkdirSync(OUT, { recursive: true });

const report = [];

for (const [i, it] of items.entries()) {
  const src = join(SITE, it.img.replace(/^\//, '').replace(/\//g, '\\'));
  if (!existsSync(src)) { console.log(`  [${i + 1}] нет файла: ${it.img}`); continue; }

  const started = Date.now();
  try {
    // Модель работает со своим разрешением, но маску возвращаем в размер оригинала.
    const image = await RawImage.read(src);
    const { pixel_values } = await processor(image);
    const out = await model({ [MODEL.input]: pixel_values });

    // Выход у разных моделей лежит под разными именами — берём первый тензор.
    // Модель отдаёт маску с batch-измерением ([1,1,H,W]), а fromTensor ждёт [C,H,W],
    // поэтому снимаем лишние оси, пока не останется три.
    let t = out.output ?? out.output_image ?? out.alphas ?? Object.values(out)[0];
    if (Array.isArray(t)) t = t[0];
    while (t.dims && t.dims.length > 3) t = t[0];

    // RMBG отдаёт готовые 0..1, BiRefNet — сырые логиты (примерно -25..23).
    // Логиты нельзя гнать в uint8 напрямую: отрицательные уходят в переполнение
    // и картинка получается «протравленной». Определяем по диапазону и сжимаем сигмоидой.
    const md = t.data;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < md.length; i++) { if (md[i] < mn) mn = md[i]; if (md[i] > mx) mx = md[i]; }
    if (mn < -0.01 || mx > 1.01) {
      for (let i = 0; i < md.length; i++) md[i] = 1 / (1 + Math.exp(-md[i]));
    }

    const maskImg = await RawImage.fromTensor(t.mul(255).to('uint8')).resize(image.width, image.height);

    // Склеиваем RGBA вручную. Оба «библиотечных» пути молча дают неверный результат:
    // joinChannel добавляет четвёртый канал, но sharp не помечает его альфой (hasAlpha=false),
    // а composite с blend:'dest-in' смотрит на альфу самой маски — у одноканального
    // grayscale она сплошная, и фон остаётся на месте. Проверено на пилоте: оба дают 100%.
    const W = maskImg.width, H = maskImg.height;
    const rgb = await sharp(src).removeAlpha().raw().toBuffer();
    const rgbaBuf = Buffer.allocUnsafe(W * H * 4);
    for (let i = 0, p = 0, q = 0; i < W * H; i++, p += 3, q += 4) {
      rgbaBuf[q] = rgb[p]; rgbaBuf[q + 1] = rgb[p + 1]; rgbaBuf[q + 2] = rgb[p + 2];
      rgbaBuf[q + 3] = maskImg.data[i];
    }
    const rgba = await sharp(rgbaBuf, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();

    // Доля непрозрачного — грубый детектор брака: почти всё стёрлось или ничего не стёрлось.
    const stats = await sharp(rgba).stats();
    const coverage = stats.channels[3] ? stats.channels[3].mean / 255 : 1;

    // Обрезка по предмету + единый квадратный холст с одинаковыми полями.
    const trimmed = await sharp(rgba).trim({ threshold: 1 }).toBuffer();
    const inner = Math.round(SIZE * (1 - PAD * 2));
    const final = await sharp(trimmed)
      .resize(inner, inner, { fit: 'inside', withoutEnlargement: false, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({
        top: 0, bottom: 0, left: 0, right: 0,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();
    const meta = await sharp(final).metadata();
    const centered = sharp({
      create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: final, left: Math.round((SIZE - meta.width) / 2), top: Math.round((SIZE - meta.height) / 2) }]);
    const canvas = await (FORMAT === 'png'
      ? centered.png({ compressionLevel: 9 })
      : centered.webp({ quality: QUALITY, alphaQuality: 100 })).toBuffer();

    const name = `${String(i + 1).padStart(2, '0')}_${basename(it.img).replace(/\.[^.]+$/, '')}.${FORMAT}`;
    writeFileSync(join(OUT, name), canvas);

    const secs = (Date.now() - started) / 1000;
    const flag = coverage > 0.92 ? ' ⚠ фон почти не убран' : coverage < 0.04 ? ' ⚠ стёрло почти всё' : '';
    console.log(`  [${i + 1}/${items.length}] ${secs.toFixed(1)}с  покрытие ${(coverage * 100).toFixed(0)}%  ${it.name.slice(0, 34)}${flag}`);

    report.push({ n: i + 1, file: name, src: it.img, name: it.name, cat: it.cat, coverage: +coverage.toFixed(3), secs: +secs.toFixed(1) });
  } catch (e) {
    console.log(`  [${i + 1}] ошибка: ${e.message}`);
    report.push({ n: i + 1, src: it.img, name: it.name, error: e.message });
  }
}

writeFileSync(join(OUT, '_report.json'), JSON.stringify({ model: MODEL.id, items: report }, null, 2), 'utf8');
const ok = report.filter((r) => !r.error);
const avg = ok.length ? (ok.reduce((a, b) => a + b.secs, 0) / ok.length) : 0;
console.log(`\nГотово: ${OUT}`);
console.log(`Успешно ${ok.length}/${items.length}, в среднем ${avg.toFixed(1)} с/кадр`);
if (ok.length) console.log(`Прогноз на 1416 фото: ~${((avg * 1416) / 60).toFixed(0)} мин`);
