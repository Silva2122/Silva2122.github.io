// Готовит логотип для шапки и подвала из донорского файла.
//
// В доноре знак лежит как JPG 4134×1157 на 640 КБ: снимок логотипа, а не логотип.
// Поля по краям огромные, фон белой заливкой, вес на два порядка больше нужного.
//
// Фон снимаем в прозрачность, а не оставляем белым, потому что мест два и фоны
// разные: шапка белая (#fff), подвал светло-серый (#F7F8F8). С белой подложкой
// в подвале проступал бы прямоугольник.
//
// Порог по «почти белому» тут не годится: у конька белое лезвие с серым контуром,
// и порог съел бы его вместе с фоном. Берём альфу из самого тёмного канала —
// чистый белый уходит в ноль, любой цветной пиксель остаётся непрозрачным,
// а множитель вытягивает полутона, чтобы бирюза не побледнела по краям.
//
//   node tools/make-logo.mjs
import sharp from 'sharp';
import { join } from 'node:path';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('..');

const SRC = join(ROOT, 'old_version', 'site', 'upload', 'CNext', 'd6c', 'd6c4675f4532b8e931b26a3df1ad7ac8.jpg');
const OUT = join(ROOT, 'assets', 'img', 'logo.webp');
const HEIGHT = 128;   // хватает на 3x при высоте 34px в шапке
const GAIN = 3;       // во сколько раз вытягиваем полупрозрачные полутона

const trimmed = await sharp(SRC).trim({ threshold: 10 }).toBuffer();
const { width, height } = await sharp(trimmed).metadata();
console.log(`Исходник: ${width}×${height} после обрезки полей`);

const rgb = await sharp(trimmed).removeAlpha().raw().toBuffer();
const rgba = Buffer.allocUnsafe(width * height * 4);
for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 3, q += 4) {
  const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
  const darkest = Math.min(r, g, b);
  rgba[q] = r; rgba[q + 1] = g; rgba[q + 2] = b;
  rgba[q + 3] = Math.min(255, (255 - darkest) * GAIN);
}

const out = await sharp(rgba, { raw: { width, height, channels: 4 } })
  .resize({ height: HEIGHT, fit: 'inside' })
  .webp({ quality: 92, alphaQuality: 100 })
  .toBuffer();

await sharp(out).toFile(OUT);
const m = await sharp(out).metadata();
console.log(`Готово: assets/img/logo.webp — ${m.width}×${m.height}, ${Math.round(out.length / 1024)} КБ`);
