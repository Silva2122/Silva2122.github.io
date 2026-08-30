// Видео в галерее товара — сжатие через ffmpeg и постер тем же sharp-конвейером,
// что и обычное фото (см. images.mjs:saveShot).
//
// Сервер слабый (1 ядро, ~1 ГБ памяти, тесно с диском — см. CLAUDE.md), поэтому
// ролик и жёстко ограничен по длине, и сжимается с preset veryfast: секунды
// обработки здесь важнее веса файла. Разъедься лимиты тут и в nginx
// (client_max_body_size, proxy_read_timeout в deploy/nginx-axelnn.conf) —
// либо nginx срежет заливку раньше node, либо оборвёт её 504 на середине сжатия.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { ROOT } from '../tools/content.mjs';
import { saveShot } from './images.mjs';

const run = promisify(execFile);

export const VIDEO_DIR = join(ROOT, 'assets', 'video', 'products');
export const MAX_INPUT = 70 * 1024 * 1024;   // тело запроса — see admin/http.mjs readBody
export const MAX_DURATION = 30;              // секунд

// ffprobe вместо попытки сразу скормить файл ffmpeg: так и длину ролика узнаём
// заранее (отказать на 40-й секунде — значит зря прогреть процессор), и не
// пытаемся сжать то, что видео не содержит вовсе (звук, битый файл).
async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json', file,
  ]);
  const info = JSON.parse(stdout);
  const duration = Number(info.format?.duration) || 0;
  const hasVideo = (info.streams || []).some((s) => s.codec_type === 'video');
  return { duration, hasVideo };
}

// id товара идёт в имя файла тем же приёмом, что и у фото (shotName
// в images.mjs) — хеш содержимого в конце, чтобы новая заливка не подменяла
// уже отданный браузерам файл.
export async function saveVideo(buffer, id) {
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 8);
  const tmpIn = join(tmpdir(), `axelnn-video-in-${hash}.tmp`);
  const tmpPoster = join(tmpdir(), `axelnn-video-poster-${hash}.png`);
  writeFileSync(tmpIn, buffer);

  try {
    const { duration, hasVideo } = await probe(tmpIn);
    if (!hasVideo) throw new Error('В файле нет видеодорожки — это не видео');
    if (!duration) throw new Error('Не получилось прочитать файл — похоже, он повреждён');
    if (duration > MAX_DURATION) {
      throw new Error(`Ролик длиннее ${MAX_DURATION} секунд — обрежьте и залейте заново`);
    }

    mkdirSync(VIDEO_DIR, { recursive: true });
    const name = `${id}-${hash}.mp4`;
    const dest = join(VIDEO_DIR, name);

    // Длинная сторона — не больше 1080 (вертикальное видео с телефона иначе
    // весит по сотне МБ), вторая scale выравнивает размеры на чётные —
    // libx264 без этого на нечётной высоте/ширине просто падает.
    await run('ffmpeg', [
      '-y', '-i', tmpIn,
      '-vf', 'scale=1080:1080:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      dest,
    ]);

    // Постер — кадр с середины ролика (первый часто чёрный, ещё до начала
    // движения), обычным фото-конвейером: тот же размер и webp, что у галереи.
    await run('ffmpeg', ['-y', '-ss', String(duration / 2), '-i', tmpIn, '-frames:v', '1', tmpPoster]);
    const posterName = `${id}-${hash}-poster.webp`;
    const posterDir = join(ROOT, 'assets', 'img', 'products');
    mkdirSync(posterDir, { recursive: true });
    await saveShot(readFileSync(tmpPoster), join(posterDir, posterName), 1800);

    return {
      video: `assets/video/products/${name}`,
      poster: `assets/img/products/${posterName}`,
    };
  } finally {
    rmSync(tmpIn, { force: true });
    rmSync(tmpPoster, { force: true });
  }
}
