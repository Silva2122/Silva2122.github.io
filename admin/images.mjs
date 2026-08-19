// Кадры, залитые через админку.
//
// Размеры и настройки те же, что у tools/prepare-product-images.mjs: карточка
// в сетке живёт на 600px, галерея товара на 1000px, fit: 'inside' — кадр
// не обрезается, потому что у товара он может быть какой угодно формы,
// и кроп срезал бы половину конька. Разъедься эти числа — залитое из админки
// фото стояло бы в сетке иначе, чем всё остальное.
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ROOT } from '../tools/content.mjs';

export const PRODUCT_IMG = join(ROOT, 'assets', 'img', 'products');
export const SECTION_IMG = join(ROOT, 'assets', 'img', 'catalog-raw');
export const PAGE_IMG = join(ROOT, 'assets', 'img', 'pages');

const WEBP = { quality: 80, alphaQuality: 100 };

export async function saveShot(buffer, dest, size) {
  await sharp(buffer)
    .rotate()                                    // развернуть по EXIF: снимки с телефона иначе лягут боком
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp(WEBP)
    .toFile(dest);
}

// Кадрирование уже залитого кадра — прямоугольником 4:5, как рамка на сайте
// (карточка в каталоге и галерея товара — обе 4:5). Источник — сам сохранённый
// webp (он уже развёрнут по EXIF и перекодирован в saveShot, повторно
// поворачивать не нужно). Координаты — пиксели исходного файла, их считает
// браузер, а не сервер: сервер только выполняет вырезку.
export async function cropShot(buffer, dest, rect) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const width = Math.max(1, Math.min(Math.round(rect.w), meta.width));
  const height = Math.max(1, Math.min(Math.round(rect.h), meta.height));
  const left = Math.max(0, Math.min(Math.round(rect.x), meta.width - width));
  const top = Math.max(0, Math.min(Math.round(rect.y), meta.height - height));
  await img
    .extract({ left, top, width, height })
    .resize(800, 1000, { fit: 'inside', withoutEnlargement: true })
    .webp(WEBP)
    .toFile(dest);
}

// Имя кадра с коротким хешем содержимого: заливка нового фото не должна
// подменять уже отданный браузерам файл — иначе у владельца в админке новый
// кадр, а у посетителя из кеша старый.
export const shotName = (prefix, buffer) =>
  `${prefix}-${createHash('sha1').update(buffer).digest('hex').slice(0, 8)}.webp`;

// Главный кадр карточки собираем из первого кадра галереи: порядок фото
// владелец меняет перетаскиванием, и «главное» должно ехать за ним само.
export async function refreshMain(product) {
  const first = (product.gallery || [])[0];
  if (!first || !existsSync(join(ROOT, first))) {
    product.img = null;
    return;
  }
  mkdirSync(PRODUCT_IMG, { recursive: true });
  const name = `${product.id}.webp`;
  await saveShot(readFileSync(join(ROOT, first)), join(PRODUCT_IMG, name), 600);
  product.img = `assets/img/products/${name}`;
}

// Фотография в шапке главной. Кадр подрезаем под ту же форму, что стоит
// в разметке (2752×1536): у <img> проставлены width и height, и снимок
// других пропорций поехал бы вместе со всем первым экраном.
// position: 'attention' — sharp сам выбирает самый «содержательный» кусок,
// а не геометрический центр, где у портретной съёмки оказывается подбородок.
export async function saveHero(buffer) {
  await sharp(buffer)
    .rotate()
    .resize(2752, 1536, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(join(ROOT, 'assets', 'img', 'hero.jpg'));
  return 'assets/img/hero.jpg';
}

// Удаляем только то, что сами и положили: путь обязан лежать внутри assets/img,
// иначе кривой запрос вынес бы что угодно из репозитория.
export function removeAsset(rel) {
  if (!rel) return;
  const file = resolve(ROOT, rel);
  const dir = resolve(ROOT, 'assets', 'img');
  if (file !== dir && !file.startsWith(dir + sep)) return;
  try { rmSync(file, { force: true }); } catch {}
}
