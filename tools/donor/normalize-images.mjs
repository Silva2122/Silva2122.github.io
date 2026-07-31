// Приводит предметные кадры к одному знаменателю: один фон, один масштаб.
//
// Зачем. Фото приходят от разных поставщиков: у одного фон чисто белый, у другого
// кремовый, у третьего светло-серый. В ряду карточек это читается как «склеено
// из чужих картинок» — главный признак дешёвого магазина. Разрешение и водяные
// знаки уже отфильтрованы, но фон и кадрирование остаются разными.
//
// Что делает: находит границы предмета, обрезает по ним, кладёт на чистый белый
// квадрат и вписывает так, чтобы предмет занимал одну и ту же долю кадра.
// Вся растровая работа — в canvas браузера, без графических зависимостей.
//
//   node tools/normalize-images.mjs            обработать assets/img/catalog
//   node tools/normalize-images.mjs --fill 78  доля кадра под предмет, %
import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../serve.mjs';
import { launch } from '../browser.mjs';

const base = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = base('../..');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = arg('--dir', 'assets/img/catalog');
const FILL = Number(arg('--fill', 78)) / 100;
const OUT_SIZE = Number(arg('--size', 1200));

const srcDir = join(ROOT, DIR);
const files = readdirSync(srcDir).filter((f) => /\.(jpe?g|png)$/i.test(f));
console.log(`Кадров: ${files.length}, поле под предмет: ${Math.round(FILL * 100)}%`);

const backup = join(ROOT, DIR + '-original');
if (!existsSync(backup)) {
  mkdirSync(backup, { recursive: true });
  for (const f of files) {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(join(srcDir, f), join(backup, f));
  }
  console.log(`Оригиналы сохранены в ${DIR}-original/`);
}

const server = await startServer({ root: ROOT, port: 0, quiet: true });
const { browser } = await launch();

try {
  const page = await browser.newPage({ viewport: { width: 300, height: 300 } });
  await page.goto(server.url + '/', { waitUntil: 'domcontentloaded' });

  const results = await page.evaluate(async ({ dir, names, fill, out }) => {
    const done = [];

    for (const name of names) {
      const img = new Image();
      const ok = await new Promise((r) => {
        img.onload = () => r(true); img.onerror = () => r(false);
        img.src = '/' + dir + '/' + encodeURIComponent(name);
      });
      if (!ok) { done.push({ name, error: 'не загрузилось' }); continue; }

      // рабочая копия, ограниченная по стороне — bbox ищем на ней
      const W = Math.min(img.naturalWidth, 1600);
      const H = Math.round(img.naturalHeight * (W / img.naturalWidth));
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;

      // Фон определяем по четырём углам: он не обязан быть белым.
      const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
      const corners = [at(2, 2), at(W - 3, 2), at(2, H - 3), at(W - 3, H - 3)];
      const bg = [0, 1, 2].map((k) => Math.round(corners.reduce((s, c) => s + c[k], 0) / 4));

      // Порог с запасом: мягкие тени под предметом не должны считаться предметом.
      const TOL = 26;
      const isBg = (i) =>
        Math.abs(px[i] - bg[0]) < TOL && Math.abs(px[i + 1] - bg[1]) < TOL && Math.abs(px[i + 2] - bg[2]) < TOL;

      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (isBg((y * W + x) * 4)) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 <= x0 || y1 <= y0) { done.push({ name, error: 'предмет не найден' }); continue; }

      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const coverage = (bw * bh) / (W * H);
      // Предмет во весь кадр — вырезать нечего, такой кадр не трогаем.
      if (coverage > 0.985) { done.push({ name, skipped: 'предмет занимает весь кадр' }); continue; }

      // Итог: белый квадрат, предмет вписан по длинной стороне.
      const o = document.createElement('canvas');
      o.width = out; o.height = out;
      const octx = o.getContext('2d');
      octx.fillStyle = '#FFFFFF';
      octx.fillRect(0, 0, out, out);
      octx.imageSmoothingQuality = 'high';

      // Баланс белого: подтягиваем каналы так, чтобы фон исходника стал чистым
      // белым. Обрезка кремовый или серый фон не убирает — он внутри кадра, и
      // в ряду карточек остаётся видимым прямоугольником. Поканальный множитель
      // убирает подложку целиком и не съедает белый товар, в отличие от
      // порогового вырезания: сохраняются относительные тона предмета.
      if (bg[0] < 253 || bg[1] < 253 || bg[2] < 253) {
        const k = bg.map((v) => 255 / Math.max(v, 1));
        const region = ctx.getImageData(x0, y0, bw, bh);
        const rp = region.data;
        for (let i = 0; i < rp.length; i += 4) {
          rp[i] = Math.min(255, rp[i] * k[0]);
          rp[i + 1] = Math.min(255, rp[i + 1] * k[1]);
          rp[i + 2] = Math.min(255, rp[i + 2] * k[2]);
        }
        const tmp = document.createElement('canvas');
        tmp.width = bw; tmp.height = bh;
        tmp.getContext('2d').putImageData(region, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(tmp, x0, y0);
      }

      const scale = (out * fill) / Math.max(bw, bh);
      const dw = bw * scale, dh = bh * scale;
      octx.drawImage(cv, x0, y0, bw, bh, (out - dw) / 2, (out - dh) / 2, dw, dh);

      // Сохраняем в том же формате, что и исходник: разметка ссылается на
      // конкретное имя файла, и менять расширение здесь — значит тихо оставить
      // часть картинок необработанными.
      const isPng = /\.png$/i.test(name);
      done.push({
        name,
        data: isPng ? o.toDataURL('image/png') : o.toDataURL('image/jpeg', 0.92),
        bg: `rgb(${bg.join(',')})`,
        was: `${bw}×${bh}`,
      });
    }
    return done;
  }, { dir: DIR.replace(/\\/g, '/'), names: files, fill: FILL, out: OUT_SIZE });

  let saved = 0;
  for (const r of results) {
    if (r.error) { console.log(`  ошибка  ${r.name}: ${r.error}`); continue; }
    if (r.skipped) { console.log(`  оставил ${r.name}: ${r.skipped}`); continue; }
    const target = join(srcDir, r.name);
    writeFileSync(target, Buffer.from(r.data.split(',')[1], 'base64'));
    saved++;
    console.log(`  ok      ${r.name}  фон ${r.bg}, предмет ${r.was}`);
  }
  console.log(`\nНормализовано: ${saved} из ${files.length} → ${OUT_SIZE}×${OUT_SIZE}, белый фон`);
} finally {
  await browser.close();
  await server.close();
}
