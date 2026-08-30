// Публикация: превращает содержимое content/ в страницы сайта.
//
// Сайт статический, поэтому «сохранить» и «показать людям» — разные действия.
// Здесь второе: тот же конвейер, что мы гоняем руками, только запущенный
// из интерфейса и с логом, который видно владельцу.
//
// Порядок жёсткий и переставлять его нельзя:
//   build-pages    правит тексты и контакты, в том числе в index.html
//   build-catalog  разносит шапку с меню из index.html по всем страницам
//   build-products собирает 1142 страницы товаров, беря шапку уже готовой
//
// Идёт в фоне, интерфейс опрашивает состояние: держать полминуты открытый
// запрос незачем, а вкладку владелец за это время может и закрыть.
import { spawn } from 'node:child_process';
import { ROOT, syncManifest } from '../tools/content.mjs';

const state = {
  running: false,
  ok: null,
  startedAt: null,
  finishedAt: null,
  log: [],
};

export const publishState = () => ({ ...state, log: state.log.slice() });
export const isRunning = () => state.running;

const say = (line) => {
  state.log.push(line);
  if (state.log.length > 400) state.log.shift();
  console.log(`  ${line}`);
};

// Без shell: путь к node.exe на Windows лежит в «Program Files» с пробелом,
// и оболочка разорвала бы его по пробелу на команду и аргумент.
function run(command, args) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: ROOT });
    const feed = (buf) => String(buf).split('\n').map((s) => s.trimEnd()).filter(Boolean).forEach(say);
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('close', (code) => done(code === 0));
    child.on('error', (e) => { say(`ошибка запуска: ${e.message}`); done(false); });
  });
}

export async function startPublish({ push = false } = {}) {
  state.running = true;
  state.ok = null;
  state.startedAt = Date.now();
  state.finishedAt = null;
  state.log = [];

  try {
    say('Правим тексты страниц и контакты…');
    let ok = await run(process.execPath, ['tools/build-pages.mjs']);

    if (ok) {
      say('Собираем подборки на главной…');
      ok = await run(process.execPath, ['tools/build-home.mjs']);
    }

    say('Готовим данные каталога…');
    const manifest = syncManifest();
    say(`Товаров в каталоге: ${manifest.length}`);

    if (ok) {
      say('Собираем меню, витрину и разделы…');
      ok = await run(process.execPath, ['tools/build-catalog.mjs']);
    }

    if (ok) {
      say('Собираем страницы товаров…');
      ok = await run(process.execPath, ['tools/build-products.mjs']);
    }

    if (ok) {
      say('Обновляем индекс поиска…');
      ok = await run(process.execPath, ['tools/build-search.mjs']);
    }

    if (ok) {
      say('Собираем sitemap.xml…');
      ok = await run(process.execPath, ['tools/build-sitemap.mjs']);
    }

    if (ok && push) {
      say('Отправляем на сайт…');
      ok = await run('git', ['add', '-A'])
        && await run('git', ['commit', '-m', 'Правки через админку'])
        && await run('git', ['push']);
    }

    state.ok = ok;
    say(ok ? 'Готово.' : 'Не получилось — смотрите сообщения выше.');
  } catch (e) {
    state.ok = false;
    say(`Ошибка: ${e.message}`);
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
  }
}
