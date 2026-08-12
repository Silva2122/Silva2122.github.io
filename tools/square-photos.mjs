// Приводит некадратные кадры товаров к квадрату — не обрезая, а достраивая
// поля своим же смазанным фоном (как объёмная обложка в Spotify/Apple Music).
//
//   node tools/square-photos.mjs          применить
//   node tools/square-photos.mjs --dry    только посчитать, ничего не писать
//
// Зачем не sharp .resize({fit:'cover', position:'attention'}): на фото
// в полный рост (а это большинство каталога — донор снимал одежду на детях)
// «умная» обрезка по сюжету то теряет голову, то ноги — алгоритм ищет самое
// контрастное пятно в кадре, а не человека целиком. Проверено на реальных
// фото перед тем, как писать этот скрипт.
//
// Вместо обрезки — задний план: тот же кадр, растянутый на весь квадрат
// (fit: cover) и сильно размытый, поверх — исходное фото целиком, вписанное
// без обрезки (fit: inside), по центру. У товаров этого каталога фон съёмки
// однотонный (светло-серый), поэтому размытый край сливается с ним почти
// незаметно, а весь снимок остаётся виден до последнего пикселя.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { ROOT, loadProducts, saveProducts, syncManifest } from './content.mjs';
import { PRODUCT_IMG, shotName, refreshMain, removeAsset } from '../admin/images.mjs';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry');
const SIZE = 1000;
const SQUARE_TOLERANCE = 0.03; // ratio 1 ± 3% уже читается как квадрат, трогать незачем

async function isSquare(path) {
  const meta = await sharp(path).metadata();
  return Math.abs(meta.width / meta.height - 1) <= SQUARE_TOLERANCE;
}

async function squareify(srcPath) {
  const buffer = readFileSync(srcPath);
  const fg = await sharp(buffer).resize(SIZE, SIZE, { fit: 'inside', withoutEnlargement: true }).toBuffer();
  const bg = await sharp(buffer)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .blur(50)
    .modulate({ brightness: 1.05 })
    .toBuffer();
  const out = await sharp(bg).composite([{ input: fg, gravity: 'center' }]).webp({ quality: 82 }).toBuffer();
  // Метка 'square-backdrop-v1' в хеше — иначе имя нового файла могло бы
  // случайно совпасть со старым (оба посчитаны от одного и того же
  // исходного буфера), а браузер отдал бы кадр из кеша под старым именем.
  const name = shotName('sq', Buffer.concat([buffer, Buffer.from('square-backdrop-v1')]));
  return { out, name };
}

const products = loadProducts();
let processed = 0, skipped = 0, mainsRefreshed = 0;
const renamed = new Map(); // старый путь -> новый, один файл может встретиться в нескольких товарах

for (const product of products) {
  const gallery = product.gallery || [];
  if (!gallery.length) continue;

  let galleryChanged = false;

  for (let i = 0; i < gallery.length; i++) {
    const rel = gallery[i];
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;

    if (renamed.has(rel)) {
      gallery[i] = renamed.get(rel);
      galleryChanged = true;
      continue;
    }

    if (await isSquare(abs)) { skipped++; continue; }

    const { out, name } = await squareify(abs);
    const newRel = `assets/img/products/${name}`;

    if (!DRY) {
      mkdirSync(PRODUCT_IMG, { recursive: true });
      await sharp(out).toFile(join(PRODUCT_IMG, name));
      removeAsset(rel);
    }

    renamed.set(rel, newRel);
    gallery[i] = newRel;
    galleryChanged = true;
    processed++;
    if (processed % 100 === 0) console.log(`  обработано: ${processed}`);
  }

  if (galleryChanged) {
    product.gallery = gallery;
    if (!DRY) await refreshMain(product);
    mainsRefreshed++;
  }
}

console.log(`\nГотово${DRY ? ' (сухой прогон, ничего не записано)' : ''}.`);
console.log(`  приведено к квадрату: ${processed}`);
console.log(`  уже были квадратные, пропущены: ${skipped}`);
console.log(`  товаров с обновлённой главной картинкой: ${mainsRefreshed}`);

if (!DRY) {
  saveProducts(products);
  const manifest = syncManifest();
  console.log(`  content/products.json сохранён, манифест пересобран (${manifest.length} товаров)`);
}
