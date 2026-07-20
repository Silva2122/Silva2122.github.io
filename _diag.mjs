// Диагностика: три способа приклеить маску как альфу
import { AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const SRC = 'C:\\Users\\ZverPC\\Desktop\\axelnn\\old_version\\site\\upload\\iblock\\04a\\04af34dc1bda2310c2e61723e8589013.jpg';

const model = await AutoModel.from_pretrained('briaai/RMBG-1.4', { dtype: 'fp32' });
const processor = await AutoProcessor.from_pretrained('briaai/RMBG-1.4');

const image = await RawImage.read(SRC);
const { pixel_values } = await processor(image);
const out = await model({ input: pixel_values });
let t = out.output;
while (t.dims && t.dims.length > 3) t = t[0];
const maskImg = await RawImage.fromTensor(t.mul(255).to('uint8')).resize(image.width, image.height);

const W = maskImg.width, H = maskImg.height;

async function report(tag, buf) {
  const m = await sharp(buf).metadata();
  const st = await sharp(buf).stats();
  const a = st.channels[3];
  console.log(`${tag}: channels=${m.channels} hasAlpha=${m.hasAlpha}` +
    (a ? `  альфа mean=${a.mean.toFixed(1)} min=${a.min} max=${a.max}  → покрытие ${(a.mean / 255 * 100).toFixed(0)}%` : '  АЛЬФЫ НЕТ'));
  return m.hasAlpha;
}

// A: joinChannel + toColourspace
try {
  const a = await sharp(SRC).removeAlpha()
    .joinChannel(maskImg.data, { raw: { width: W, height: H, channels: 1 } })
    .toColourspace('srgb').png().toBuffer();
  await report('A joinChannel+toColourspace', a);
} catch (e) { console.log('A ошибка:', e.message); }

// B: ensureAlpha + composite dest-in, маска как серое PNG
try {
  const maskPng = await sharp(maskImg.data, { raw: { width: W, height: H, channels: 1 } })
    .ensureAlpha().png().toBuffer();
  const b = await sharp(SRC).ensureAlpha()
    .composite([{ input: maskPng, blend: 'dest-in' }]).png().toBuffer();
  await report('B composite dest-in', b);
} catch (e) { console.log('B ошибка:', e.message); }

// C: ручная сборка RGBA
try {
  const rgb = await sharp(SRC).removeAlpha().raw().toBuffer();
  const rgba = Buffer.allocUnsafe(W * H * 4);
  for (let i = 0, p = 0, q = 0; i < W * H; i++, p += 3, q += 4) {
    rgba[q] = rgb[p]; rgba[q + 1] = rgb[p + 1]; rgba[q + 2] = rgb[p + 2]; rgba[q + 3] = maskImg.data[i];
  }
  const c = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const ok = await report('C ручная сборка RGBA', c);
  if (ok) { writeFileSync('_diag-out.png', c); console.log('сохранено _diag-out.png'); }
} catch (e) { console.log('C ошибка:', e.message); }
