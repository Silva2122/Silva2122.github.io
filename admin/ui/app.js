/* ==========================================================================
   Админка Аксель·НН — интерфейс
   ==========================================================================
   Никакой сборки и никаких библиотек: тот же подход, что на самом сайте.
   Экранов пять, состояние помещается в один объект, а разметка собирается
   функциями — реактивный фреймворк здесь дал бы больше файлов, чем пользы.

   Адрес экрана живёт в хеше (#/products/16341), поэтому «назад» в браузере
   работает как ожидается, а ссылку на товар можно оставить открытой во вкладке.
   ========================================================================== */

(function () {
  'use strict';

  var root = document.getElementById('root');
  var toastBox = document.getElementById('toast');
  var toastTimer = null;

  // --- мелкая помощь ------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var k in attrs || {}) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = Boolean(v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function toast(message, bad) {
    toastBox.textContent = message;
    toastBox.hidden = false;
    toastBox.style.background = bad ? '#B3261E' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastBox.hidden = true; }, bad ? 5000 : 2600);
  }

  function money(n) {
    if (n == null || n === '') return 'Цена по запросу';
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
  }

  function plural(n, one, few, many) {
    var d = n % 10, h = n % 100;
    if (d === 1 && h !== 11) return one;
    if (d >= 2 && d <= 4 && (h < 10 || h > 20)) return few;
    return many;
  }

  // Запрос к серверу. Ошибку показываем текстом сервера — он пишет по-русски
  // и по делу («Пароль короче четырёх знаков»), а не кодом состояния.
  function api(path, options) {
    options = options || {};
    var init = { method: options.method || 'GET', headers: {} };
    if (options.body !== undefined) {
      if (options.body instanceof Blob) init.body = options.body;
      else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body); }
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('Ошибка ' + res.status));
        return data;
      });
    });
  }

  // --- состояние ----------------------------------------------------------

  var state = {
    route: { name: 'products', id: null },
    sections: [],
    filter: { q: '', section: '', state: '', page: 1 },
    product: null,
    publishTimer: null,
  };

  // ==========================================================================
  // Вход
  // ==========================================================================

  function screenLogin() {
    var error = el('div', { class: 'note note--bad', hidden: true });

    var login = el('input', { class: 'input', type: 'text', autocomplete: 'username', value: 'admin' });
    var password = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });

    var form = el('form', { class: 'login__box', onsubmit: function (e) {
      e.preventDefault();
      api('/api/login', { method: 'POST', body: { login: login.value, password: password.value } })
        .then(function () { location.hash = '#/'; start(); })
        .catch(function (err) { error.textContent = err.message; error.hidden = false; });
    } }, [
      el('img', { class: 'login__logo', src: '/assets/img/logo.webp', alt: 'Аксель·НН' }),
      el('h1', { class: 'login__title', text: 'Управление сайтом' }),
      error,
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Логин' }), login]),
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Пароль' }), password]),
      el('button', { class: 'btn', type: 'submit', style: 'width:100%', text: 'Войти' }),
    ]);

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'login' }, [form]));
    setTimeout(function () { password.focus(); }, 50);
  }

  // ==========================================================================
  // Каркас: боковое меню и место под экран
  // ==========================================================================

  var MENU = [
    { key: 'products', title: 'Товары' },
    { key: 'sections', title: 'Разделы каталога' },
    { key: 'texts', title: 'Тексты страниц' },
    { key: 'contacts', title: 'Контакты' },
    { key: 'publish', title: 'Публикация' },
  ];

  function frame(view) {
    var side = el('nav', { class: 'side' }, [
      el('a', { class: 'side__logo', href: '/', target: '_blank' }, [
        el('img', { src: '/assets/img/logo.webp', alt: 'Аксель·НН' }),
      ]),
    ]);

    MENU.forEach(function (item) {
      side.appendChild(el('a', {
        class: 'side__link',
        href: '#/' + item.key,
        'aria-current': state.route.name === item.key ? 'page' : null,
        text: item.title,
      }));
    });

    side.appendChild(el('div', { class: 'side__foot' }, [
      el('a', { class: 'side__link', href: '/', target: '_blank', text: 'Открыть сайт ↗' }),
      el('button', { class: 'side__link', type: 'button', text: 'Выйти', onclick: function () {
        api('/api/logout', { method: 'POST' }).then(screenLogin);
      } }),
    ]));

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'app' }, [side, el('main', { class: 'main', id: 'view' }, [view])]));
  }

  function setView(node) {
    var box = document.getElementById('view');
    if (!box) return frame(node);
    box.innerHTML = '';
    box.appendChild(node);
  }

  // ==========================================================================
  // Товары
  // ==========================================================================

  function screenProducts() {
    var box = el('div');
    frame(box);

    var search = el('input', {
      class: 'input toolbar__search', type: 'search', value: state.filter.q,
      placeholder: 'Найти по названию, артикулу или бренду',
    });

    // Ищем не на каждую букву: список в полторы тысячи товаров, и запрос
    // на каждое нажатие только мигал бы содержимым.
    var typing = null;
    search.addEventListener('input', function () {
      clearTimeout(typing);
      typing = setTimeout(function () {
        state.filter.q = search.value.trim();
        state.filter.page = 1;
        load();
      }, 250);
    });

    var pickSection = el('select', { class: 'select toolbar__pick', onchange: function () {
      state.filter.section = pickSection.value;
      state.filter.page = 1;
      load();
    } }, [el('option', { value: '', text: 'Все разделы' })]);

    state.sections.forEach(function (s) {
      pickSection.appendChild(el('option', {
        value: s.key,
        selected: state.filter.section === s.key,
        text: s.title + ' (' + s.total + ')',
      }));
    });

    var pickState = el('select', { class: 'select toolbar__pick', onchange: function () {
      state.filter.state = pickState.value;
      state.filter.page = 1;
      load();
    } }, [
      el('option', { value: '', text: 'Любые' }),
      el('option', { value: 'shown', selected: state.filter.state === 'shown', text: 'Показываются на сайте' }),
      el('option', { value: 'hidden', selected: state.filter.state === 'hidden', text: 'Скрытые' }),
      el('option', { value: 'nophoto', selected: state.filter.state === 'nophoto', text: 'Без фотографии' }),
    ]);

    var list = el('div', { class: 'items' }, [el('div', { class: 'empty', text: 'Загружаем…' })]);
    var pager = el('div', { class: 'pager' });
    var counter = el('p', { class: 'head__sub' });

    box.appendChild(el('div', { class: 'head' }, [
      el('div', {}, [el('h1', { class: 'head__title', text: 'Товары' }), counter]),
      el('button', { class: 'btn', type: 'button', text: '+ Добавить товар', onclick: newProduct }),
    ]));
    box.appendChild(el('div', { class: 'toolbar' }, [search, pickSection, pickState]));
    box.appendChild(list);
    box.appendChild(pager);

    function load() {
      var q = new URLSearchParams({
        q: state.filter.q, section: state.filter.section,
        state: state.filter.state, page: state.filter.page, per: 40,
      });
      api('/api/products?' + q).then(function (data) {
        counter.textContent = data.total + ' ' + plural(data.total, 'товар', 'товара', 'товаров');
        list.innerHTML = '';
        if (!data.items.length) {
          list.appendChild(el('div', { class: 'empty', text: 'Ничего не нашлось. Попробуйте другой запрос.' }));
        }
        data.items.forEach(function (p) { list.appendChild(itemRow(p)); });

        pager.innerHTML = '';
        if (data.pages > 1) {
          pager.appendChild(el('button', {
            class: 'btn btn--ghost btn--small', type: 'button', text: '← Назад',
            disabled: data.page <= 1,
            onclick: function () { state.filter.page--; load(); window.scrollTo(0, 0); },
          }));
          pager.appendChild(el('span', { class: 'pager__now', text: 'Страница ' + data.page + ' из ' + data.pages }));
          pager.appendChild(el('button', {
            class: 'btn btn--ghost btn--small', type: 'button', text: 'Дальше →',
            disabled: data.page >= data.pages,
            onclick: function () { state.filter.page++; load(); window.scrollTo(0, 0); },
          }));
        }
      }).catch(function (e) { toast(e.message, true); });
    }

    load();
  }

  function itemRow(p) {
    var media = p.img
      ? el('img', { src: '/' + p.img, alt: '', loading: 'lazy' })
      : el('span', { text: 'нет фото' });

    var marks = [];
    if (p.hidden) marks.push(el('span', { class: 'tag tag--off', text: 'скрыт' }));
    else if (!p.img) marks.push(el('span', { class: 'tag tag--wait', text: 'нет фото — не на сайте' }));
    if (!p.available) marks.push(el('span', { class: 'tag', text: 'под заказ' }));
    if (p.sizes) marks.push(el('span', { class: 'tag', text: p.sizes + ' ' + plural(p.sizes, 'размер', 'размера', 'размеров') }));

    var meta = el('div', { class: 'item__meta' }, [
      el('span', { text: 'арт. ' + p.id }),
      el('span', { text: p.cat || '—' }),
    ].concat(marks));

    return el('button', {
      class: 'item', type: 'button',
      onclick: function () { location.hash = '#/products/' + encodeURIComponent(p.id); },
    }, [
      el('div', { class: 'item__media' }, [media]),
      el('div', {}, [el('div', { class: 'item__name', text: p.name }), meta]),
      el('div', { class: 'item__price' }, [
        el('span', { text: money(p.price) }),
        p.oldPrice ? el('span', { class: 'item__old', text: money(p.oldPrice) }) : null,
      ]),
    ]);
  }

  function newProduct() {
    if (!state.sections.length) return toast('Сначала должны появиться разделы', true);

    var pickSection = el('select', { class: 'select' }, state.sections.map(function (s) {
      return el('option', { value: s.key, text: s.title });
    }));
    // Подразделов как отдельной сущности нет — они выводятся из товаров.
    // Поэтому это поле, а не выпадающий список: можно выбрать из подсказки
    // существующий, а можно вписать новое название — подраздел появится
    // сам, как только в нём окажется первый товар (см. subTitle в api.mjs).
    var subsList = el('datalist', { id: 'new-product-subs' });
    var pickSub = el('input', {
      class: 'input', list: 'new-product-subs',
      placeholder: 'Например: Коньки Jackson (необязательно, можно вписать новый)',
    });
    var name = el('input', { class: 'input', placeholder: 'Например: Чехлы на лезвия Edea' });

    function fillSubs() {
      var section = state.sections.filter(function (s) { return s.key === pickSection.value; })[0];
      subsList.innerHTML = '';
      (section ? section.subs : []).forEach(function (sub) {
        subsList.appendChild(el('option', { value: sub.title }));
      });
    }
    pickSection.addEventListener('change', fillSubs);
    fillSubs();

    var box = el('div');
    frame(box);
    box.appendChild(el('div', { class: 'head' }, [
      el('div', {}, [
        el('h1', { class: 'head__title', text: 'Новый товар' }),
        el('p', { class: 'head__sub', text: 'Название и место в каталоге. Фото, цену и описание добавите на следующем шаге.' }),
      ]),
    ]));

    box.appendChild(el('div', { class: 'card' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Название' }), name]),
      el('div', { class: 'row' }, [
        el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Раздел' }), pickSection]),
        el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Подраздел' }), pickSub, subsList]),
      ]),
      el('div', { class: 'bar', style: 'position:static;background:none;margin-top:6px' }, [
        el('button', { class: 'btn', type: 'button', text: 'Создать', onclick: function () {
          if (!name.value.trim()) return toast('Впишите название', true);
          api('/api/products', { method: 'POST', body: {
            name: name.value.trim(), section: pickSection.value, subTitle: pickSub.value.trim(),
          } }).then(function (p) {
            toast('Товар создан');
            location.hash = '#/products/' + encodeURIComponent(p.id);
          }).catch(function (e) { toast(e.message, true); });
        } }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'Отмена', onclick: function () {
          // Хэш уже #/products (сюда попадают без смены хэша, прямо из
          // screenProducts) — просто выставить его снова hashchange не даст,
          // нужен явный повторный рендер.
          location.hash = '#/products';
          render();
        } }),
      ]),
    ]));
  }

  // --- редактор товара ----------------------------------------------------

  function screenProduct(id) {
    api('/api/products/' + encodeURIComponent(id)).then(function (p) {
      state.product = p;
      drawProduct(p);
    }).catch(function (e) {
      toast(e.message, true);
      location.hash = '#/products';
    });
  }

  function drawProduct(p) {
    var box = el('div');
    frame(box);

    var name = el('input', { class: 'input', value: p.name || '' });
    var price = el('input', { class: 'input', type: 'number', min: '0', step: '10', value: p.price == null ? '' : p.price });
    var oldPrice = el('input', { class: 'input', type: 'number', min: '0', step: '10', value: p.oldPrice == null ? '' : p.oldPrice });
    var brand = el('input', { class: 'input', value: p.brand || '' });
    var descr = el('textarea', { class: 'textarea', value: (p.description || []).join('\n\n') });

    var available = switchField('В наличии', 'Выключите — на странице будет «под заказ»', p.available !== false);
    var hidden = switchField('Скрыть с сайта', 'Товар останется здесь, но пропадёт из каталога', Boolean(p.hidden));

    // --- размеры ---
    var sizes = (p.sizes || []).slice();
    var sizeBox = el('div', { class: 'sizes' });
    var sizeInput = el('input', { class: 'input', placeholder: 'Например: 128 — и Enter' });

    function drawSizes() {
      sizeBox.innerHTML = '';
      sizes.forEach(function (s, i) {
        var sizePrice = el('input', {
          class: 'size__price', type: 'number', min: '0', step: '10',
          placeholder: price.value || 'как у товара',
          value: s.price == null ? '' : s.price,
        });
        sizePrice.addEventListener('change', function () {
          s.price = sizePrice.value === '' ? null : Number(sizePrice.value);
        });
        sizeBox.appendChild(el('span', { class: 'size' }, [
          document.createTextNode(s.size),
          sizePrice,
          el('button', { type: 'button', title: 'Убрать', text: '×', onclick: function () {
            sizes.splice(i, 1); drawSizes();
          } }),
        ]));
      });
      if (!sizes.length) sizeBox.appendChild(el('span', { class: 'field__hint', text: 'Размеров нет — товар кладётся в корзину сразу' }));
    }
    drawSizes();

    sizeInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var value = sizeInput.value.trim();
      if (value && sizes.every(function (s) { return s.size !== value; })) {
        sizes.push({ size: value, price: null });
        drawSizes();
      }
      sizeInput.value = '';
    });

    // --- фотографии ---
    var gallery = (p.gallery || []).slice();
    var shots = el('div', { class: 'shots' });
    var dragFrom = null;

    function drawShots() {
      shots.innerHTML = '';
      gallery.forEach(function (src, i) {
        var cell = el('div', {
          class: 'shot', draggable: true, 'data-first': i === 0 ? true : null,
          ondragstart: function () { dragFrom = i; },
          ondragover: function (e) { e.preventDefault(); cell.classList.add('shot--over'); },
          ondragleave: function () { cell.classList.remove('shot--over'); },
          ondrop: function (e) {
            e.preventDefault();
            cell.classList.remove('shot--over');
            if (dragFrom == null || dragFrom === i) return;
            var moved = gallery.splice(dragFrom, 1)[0];
            gallery.splice(i, 0, moved);
            dragFrom = null;
            drawShots();
          },
        }, [
          el('img', { src: '/' + src, alt: '' }),
          el('button', { class: 'shot__del', type: 'button', title: 'Удалить фото', text: '×', onclick: function (e) {
            e.stopPropagation();
            gallery.splice(i, 1);
            drawShots();
          } }),
        ]);
        shots.appendChild(cell);
      });
      if (!gallery.length) {
        shots.appendChild(el('div', { class: 'field__hint', style: 'grid-column:1/-1', text: 'Фотографий пока нет. Товар без фото на сайте не показывается.' }));
      }
    }
    drawShots();

    var fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, onchange: function () {
      upload(fileInput.files);
      fileInput.value = '';
    } });

    var drop = el('label', { class: 'drop',
      ondragover: function (e) { e.preventDefault(); drop.classList.add('drop--over'); },
      ondragleave: function () { drop.classList.remove('drop--over'); },
      ondrop: function (e) {
        e.preventDefault();
        drop.classList.remove('drop--over');
        upload(e.dataTransfer.files);
      },
    }, [
      el('span', { text: 'Перетащите фотографии сюда или нажмите, чтобы выбрать' }),
      fileInput,
    ]);

    // Кадры уходят по одному: так видно, на каком именно сломалось, и
    // ползунок прогресса не нужен — каждая загрузка сразу появляется в сетке.
    function upload(files) {
      var queue = Array.prototype.slice.call(files || []);
      if (!queue.length) return;
      drop.classList.add('drop--over');

      (function next() {
        var file = queue.shift();
        if (!file) {
          drop.classList.remove('drop--over');
          toast('Фото загружено');
          return;
        }
        api('/api/products/' + encodeURIComponent(p.id) + '/photo', { method: 'POST', body: file })
          .then(function (fresh) {
            gallery = fresh.gallery.slice();
            p.img = fresh.img;
            drawShots();
            next();
          })
          .catch(function (e) {
            drop.classList.remove('drop--over');
            toast(e.message, true);
          });
      })();
    }

    // --- сохранение ---
    function save(then) {
      api('/api/products/' + encodeURIComponent(p.id), { method: 'PUT', body: {
        name: name.value,
        price: price.value,
        oldPrice: oldPrice.value,
        available: available.input.checked,
        hidden: hidden.input.checked,
        brand: brand.value,
        sizes: sizes,
        description: descr.value.split('\n'),
        gallery: gallery,
      } }).then(function (fresh) {
        state.product = fresh;
        toast('Сохранено');
        if (then) then();
      }).catch(function (e) { toast(e.message, true); });
    }

    box.appendChild(el('div', { class: 'head' }, [
      el('div', {}, [
        el('h1', { class: 'head__title', text: p.name || 'Товар' }),
        el('p', { class: 'head__sub', text: 'Артикул ' + p.id + ' · ' + (p.cat || '—') }),
      ]),
      el('a', { class: 'btn btn--ghost', href: p.url, target: '_blank', text: 'Открыть на сайте ↗' }),
    ]));

    box.appendChild(el('div', { class: 'editor' }, [
      el('div', { class: 'card' }, [
        el('h2', { class: 'card__title', text: 'Фотографии' }),
        shots,
        drop,
        el('p', { class: 'field__hint', text: 'Первое фото — главное: оно стоит в каталоге. Перетащите кадр, чтобы поменять порядок.' }),
      ]),

      el('div', {}, [
        el('div', { class: 'card' }, [
          el('h2', { class: 'card__title', text: 'Основное' }),
          el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Название' }), name]),
          el('div', { class: 'row' }, [
            el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Цена, ₽' }), price]),
            el('label', { class: 'field' }, [
              el('span', { class: 'field__label', text: 'Старая цена, ₽' }), oldPrice,
              el('span', { class: 'field__hint', text: 'Появится зачёркнутой рядом с ценой' }),
            ]),
          ]),
          el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Бренд' }), brand]),
          available.node,
          hidden.node,
        ]),

        el('div', { class: 'card' }, [
          el('h2', { class: 'card__title', text: 'Размеры' }),
          sizeBox,
          sizeInput,
          el('p', { class: 'field__hint', text: 'Если размеры есть, покупатель выбирает их на странице товара. '
            + 'Цена у размера — необязательна: пусто значит «как обычная цена товара». Если у размеров разные цены, '
            + 'в каталоге и в шапке страницы товара покажется «от» самой дешёвой.' }),
        ]),

        el('div', { class: 'card' }, [
          el('h2', { class: 'card__title', text: 'Описание' }),
          descr,
          el('p', { class: 'field__hint', text: 'Каждая строка — отдельный абзац. Пустые строки не важны.' }),
        ]),
      ]),
    ]));

    box.appendChild(el('div', { class: 'bar' }, [
      el('button', { class: 'btn', type: 'button', text: 'Сохранить', onclick: function () { save(); } }),
      el('button', { class: 'btn btn--ghost', type: 'button', text: 'Назад к списку', onclick: function () {
        location.hash = '#/products';
      } }),
      el('span', { class: 'bar__spacer' }),
      el('button', { class: 'btn btn--danger', type: 'button', text: 'Удалить товар', onclick: function () {
        if (!confirm('Удалить «' + (p.name || p.id) + '»? Вместе с фотографиями, без возможности вернуть.')) return;
        api('/api/products/' + encodeURIComponent(p.id), { method: 'DELETE' }).then(function () {
          toast('Товар удалён');
          location.hash = '#/products';
        }).catch(function (e) { toast(e.message, true); });
      } }),
    ]));

    box.appendChild(el('p', { class: 'field__hint', style: 'margin-top:8px',
      text: 'Правки видны на сайте после публикации — раздел «Публикация» слева.' }));
  }

  function switchField(title, hint, on) {
    var input = el('input', { type: 'checkbox', checked: on });
    var node = el('label', { class: 'switch' }, [
      input,
      el('span', { class: 'switch__track' }),
      el('span', { class: 'switch__text' }, [
        document.createTextNode(title),
        hint ? el('span', { class: 'field__hint', text: hint }) : null,
      ]),
    ]);
    return { node: node, input: input };
  }

  // ==========================================================================
  // Разделы каталога
  // ==========================================================================

  function screenSections() {
    var box = el('div');
    frame(box);

    box.appendChild(el('div', { class: 'head' }, [
      el('div', {}, [
        el('h1', { class: 'head__title', text: 'Разделы каталога' }),
        el('p', { class: 'head__sub', text: 'Порядок здесь — это порядок в меню, на витрине и в подвале сайта.' }),
      ]),
    ]));

    var newTitle = el('input', { class: 'input', placeholder: 'Например: Термобельё' });
    function addSection() {
      if (!newTitle.value.trim()) return toast('Впишите название раздела', true);
      api('/api/sections', { method: 'POST', body: { title: newTitle.value.trim() } })
        .then(function (fresh) {
          state.sections = fresh;
          sections = fresh.slice();
          newTitle.value = '';
          draw();
          toast('Раздел добавлен — теперь можно загрузить картинку и добавить в него товары');
        })
        .catch(function (e) { toast(e.message, true); });
    }
    newTitle.addEventListener('keydown', function (e) { if (e.key === 'Enter') addSection(); });
    box.appendChild(el('div', { class: 'card' }, [
      el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Новый раздел' }), newTitle]),
      el('div', { class: 'bar', style: 'position:static;background:none;margin-top:6px' }, [
        el('button', { class: 'btn', type: 'button', text: '+ Добавить раздел', onclick: addSection }),
      ]),
    ]));

    var list = el('div');
    box.appendChild(list);

    var sections = state.sections.slice();

    function save() {
      api('/api/sections', { method: 'PUT', body: sections.map(function (s) {
        return { key: s.key, title: s.title, hidden: s.hidden, img: s.img, cut: s.cut };
      }) }).then(function (fresh) {
        state.sections = fresh;
        sections = fresh.slice();
        draw();
        toast('Сохранено');
      }).catch(function (e) { toast(e.message, true); });
    }

    function draw() {
      list.innerHTML = '';
      sections.forEach(function (s, i) {
        var picker = el('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: function () {
          if (!picker.files[0]) return;
          api('/api/sections/' + encodeURIComponent(s.key) + '/photo', { method: 'POST', body: picker.files[0] })
            .then(function (fresh) {
              state.sections = fresh;
              sections = fresh.slice();
              draw();
              toast('Картинка раздела обновлена');
            })
            .catch(function (e) { toast(e.message, true); });
        } });

        var media = el('div', { class: 'section-row__media', title: 'Заменить картинку', onclick: function () { picker.click(); } }, [
          s.img ? el('img', { src: '/' + s.img, alt: '', loading: 'lazy' }) : el('span', { text: 'нет' }),
          picker,
        ]);

        var title = el('input', { class: 'input', value: s.title, onchange: function () { s.title = title.value; } });

        var hide = switchField('Показывать', null, !s.hidden);
        hide.input.addEventListener('change', function () { s.hidden = !hide.input.checked; });

        list.appendChild(el('div', { class: 'section-row' }, [
          media,
          el('div', {}, [
            title,
            el('p', { class: 'field__hint', text: s.shown + ' из ' + s.total + ' товаров на сайте · '
              + s.subs.length + ' ' + plural(s.subs.length, 'подраздел', 'подраздела', 'подразделов') }),
          ]),
          hide.node,
          el('div', { class: 'section-row__moves' }, [
            el('button', { class: 'move', type: 'button', title: 'Выше', text: '↑', disabled: i === 0, onclick: function () {
              sections.splice(i - 1, 0, sections.splice(i, 1)[0]); draw();
            } }),
            el('button', { class: 'move', type: 'button', title: 'Ниже', text: '↓', disabled: i === sections.length - 1, onclick: function () {
              sections.splice(i + 1, 0, sections.splice(i, 1)[0]); draw();
            } }),
          ]),
        ]));
      });
    }

    draw();

    box.appendChild(el('div', { class: 'bar' }, [
      el('button', { class: 'btn', type: 'button', text: 'Сохранить порядок и названия', onclick: save }),
    ]));
  }

  // ==========================================================================
  // Тексты страниц
  // ==========================================================================
  // Страница правится не целиком, а своими текстовыми местами: заголовки,
  // абзацы, пункты списков. Вёрстка при этом остаётся нетронутой — владелец
  // не может случайно сломать разметку, потому что до неё не дотягивается.

  function screenTexts() {
    var box = el('div');
    frame(box);

    box.appendChild(el('div', { class: 'head' }, [
      el('div', {}, [
        el('h1', { class: 'head__title', text: 'Тексты страниц' }),
        el('p', { class: 'head__sub', text: 'Выберите страницу — и правьте заголовки и абзацы прямо в полях.' }),
      ]),
    ]));

    var list = el('div', { class: 'items' }, [el('div', { class: 'empty', text: 'Загружаем…' })]);
    box.appendChild(list);

    api('/api/pages').then(function (pages) {
      list.innerHTML = '';
      pages.forEach(function (page) {
        list.appendChild(el('button', {
          class: 'item', type: 'button', style: 'grid-template-columns: 1fr auto',
          onclick: function () { location.hash = '#/texts/' + encodeURIComponent(page.file); },
        }, [
          el('div', {}, [
            el('div', { class: 'item__name', text: page.title }),
            el('div', { class: 'item__meta' }, [
              el('span', { text: page.url }),
              el('span', { text: page.slots + ' ' + plural(page.slots, 'место для правки', 'места для правки', 'мест для правки') }),
              page.pending ? el('span', { class: 'tag tag--wait', text: 'не опубликовано: ' + page.pending }) : null,
            ]),
          ]),
          el('span', { class: 'item__price', text: '→' }),
        ]));
      });
    }).catch(function (e) { toast(e.message, true); });
  }

  function screenText(file) {
    api('/api/pages/' + encodeURIComponent(file)).then(function (page) {
      var box = el('div');
      frame(box);

      var fields = {};

      box.appendChild(el('div', { class: 'head' }, [
        el('div', {}, [
          el('h1', { class: 'head__title', text: page.title }),
          el('p', { class: 'head__sub', text: 'Каждое поле — отдельный кусок текста на странице, сверху вниз.' }),
        ]),
        el('a', { class: 'btn btn--ghost', href: page.url, target: '_blank', text: 'Посмотреть страницу ↗' }),
      ]));

      // У главной сверху фотография во весь экран — она правится не текстом,
      // а заменой файла, поэтому стоит отдельной карточкой над полями.
      if (file === 'index.html') box.appendChild(heroCard());

      var card = el('div', { class: 'card' });
      page.slots.forEach(function (slot) {
        var input = el('textarea', { class: 'textarea textarea--auto', value: slot.text, rows: 2 });
        input.addEventListener('input', function () { grow(input); });
        fields[slot.key] = input;

        card.appendChild(el('label', { class: 'field' }, [
          el('span', { class: 'field__label' }, [
            document.createTextNode(slot.label),
            slot.changed ? el('span', { class: 'tag tag--wait', style: 'margin-left:8px', text: 'изменено' }) : null,
          ]),
          input,
        ]));
      });
      box.appendChild(card);

      // Высоту полей считаем только теперь: у элемента вне документа
      // scrollHeight равен нулю, и все поля схлопнулись бы в одну строку.
      Object.keys(fields).forEach(function (key) { grow(fields[key]); });

      box.appendChild(el('div', { class: 'bar' }, [
        el('button', { class: 'btn', type: 'button', text: 'Сохранить', onclick: function () {
          var edits = {};
          Object.keys(fields).forEach(function (key) { edits[key] = fields[key].value; });
          api('/api/pages/' + encodeURIComponent(file), { method: 'PUT', body: { edits: edits } })
            .then(function () { toast('Сохранено. Опубликуйте, чтобы увидеть на сайте'); })
            .catch(function (e) { toast(e.message, true); });
        } }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'К списку страниц', onclick: function () {
          location.hash = '#/texts';
        } }),
      ]));
    }).catch(function (e) {
      toast(e.message, true);
      location.hash = '#/texts';
    });
  }

  // Фотография в шапке главной правится не текстом, а заменой файла.
  // Публикация ей не нужна: кадр лежит в assets/ и подхватывается сайтом сразу.
  function heroCard() {
    // Метка времени в адресе — иначе после замены браузер покажет из кеша
    // прежний кадр, и владелец решит, что загрузка не сработала.
    var stamp = function () { return '/assets/img/hero.jpg?' + Date.now(); };
    var preview = el('img', { src: stamp(), alt: '', style: 'width:100%;border-radius:10px;display:block' });

    function send(file) {
      if (!file) return;
      drop.classList.add('drop--over');
      api('/api/hero', { method: 'POST', body: file })
        .then(function () {
          preview.src = stamp();
          drop.classList.remove('drop--over');
          toast('Фотография заменена');
        })
        .catch(function (e) {
          drop.classList.remove('drop--over');
          toast(e.message, true);
        });
    }

    var input = el('input', { type: 'file', accept: 'image/*', onchange: function () {
      send(input.files[0]);
      input.value = '';
    } });

    var drop = el('label', { class: 'drop',
      ondragover: function (e) { e.preventDefault(); drop.classList.add('drop--over'); },
      ondragleave: function () { drop.classList.remove('drop--over'); },
      ondrop: function (e) { e.preventDefault(); send(e.dataTransfer.files[0]); },
    }, [el('span', { text: 'Перетащите новую фотографию сюда или нажмите, чтобы выбрать' }), input]);

    return el('div', { class: 'card' }, [
      el('h2', { class: 'card__title', text: 'Фотография в шапке' }),
      preview,
      drop,
      el('p', { class: 'field__hint', text: 'Кадр обрежется под нужную форму сам. Берите снимок пошире: вертикальный сильно потеряет по краям.' }),
    ]);
  }

  // Поле растёт под текст: абзацы бывают и в строку, и на пол-экрана,
  // а полоса прокрутки внутри поля мешает читать то, что правишь.
  function grow(area) {
    area.style.height = 'auto';
    area.style.height = (area.scrollHeight + 2) + 'px';
  }

  // ==========================================================================
  // Контакты
  // ==========================================================================
  // Телефон и почта стоят в шапке, подвале и на «Контактах» — и в тексте,
  // и в ссылке. Здесь они правятся один раз и расходятся по всему сайту.

  function screenContacts() {
    var box = el('div');
    frame(box);

    box.appendChild(el('div', { class: 'head' }, [
      el('div', {}, [
        el('h1', { class: 'head__title', text: 'Контакты' }),
        el('p', { class: 'head__sub', text: 'Меняются сразу на всех страницах сайта — в шапке, в подвале и на странице контактов.' }),
      ]),
    ]));

    api('/api/site').then(function (site) {
      var phone = el('input', { class: 'input', value: site.phone || '', placeholder: '+7 831 423-47-96' });
      var email = el('input', { class: 'input', type: 'email', value: site.email || '', placeholder: 'info@axelnn.ru' });
      var vk = el('input', { class: 'input', value: site.vk || '', placeholder: 'https://vk.com/axelnn' });
      var telegram = el('input', { class: 'input', value: site.telegram || '', placeholder: 'https://t.me/…' });

      box.appendChild(el('div', { class: 'card' }, [
        el('label', { class: 'field' }, [
          el('span', { class: 'field__label', text: 'Телефон' }), phone,
          el('span', { class: 'field__hint', text: 'Пишите как на сайте: +7 831 423-47-96. Ссылка «позвонить» соберётся сама.' }),
        ]),
        el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Почта' }), email]),
        el('div', { class: 'row' }, [
          el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'ВКонтакте' }), vk]),
          el('label', { class: 'field' }, [el('span', { class: 'field__label', text: 'Телеграм' }), telegram]),
        ]),
        el('p', { class: 'field__hint', text: 'Адрес и режим работы правятся текстом — в разделе «Тексты страниц», страница «Контакты».' }),
      ]));

      box.appendChild(el('div', { class: 'bar' }, [
        el('button', { class: 'btn', type: 'button', text: 'Сохранить', onclick: function () {
          api('/api/site', { method: 'PUT', body: {
            phone: phone.value.trim(), email: email.value.trim(),
            vk: vk.value.trim(), telegram: telegram.value.trim(),
          } }).then(function () { toast('Сохранено. Опубликуйте, чтобы увидеть на сайте'); })
            .catch(function (e) { toast(e.message, true); });
        } }),
      ]));
    }).catch(function (e) { toast(e.message, true); });
  }

  // ==========================================================================
  // Публикация
  // ==========================================================================

  function screenPublish() {
    var box = el('div');
    frame(box);

    var stats = el('div', { class: 'stats' });
    var status = el('span', { class: 'state' }, [el('span', { class: 'state__dot' }), el('span', { text: 'Готово к публикации' })]);
    var log = el('pre', { class: 'log', text: 'Здесь появится отчёт о сборке.' });
    var push = switchField('Сразу отправить на GitHub', 'Выключите, если хотите сначала посмотреть результат у себя', false);

    var button = el('button', { class: 'btn', type: 'button', text: 'Опубликовать изменения', onclick: function () {
      button.disabled = true;
      api('/api/publish', { method: 'POST', body: { push: push.input.checked } })
        .then(watch)
        .catch(function (e) { button.disabled = false; toast(e.message, true); });
    } });

    box.appendChild(el('div', { class: 'head' }, [
      el('div', {}, [
        el('h1', { class: 'head__title', text: 'Публикация' }),
        el('p', { class: 'head__sub', text: 'Собирает страницы заново: меню, витрину, разделы и карточки товаров.' }),
      ]),
    ]));
    box.appendChild(stats);
    box.appendChild(el('div', { class: 'card' }, [
      push.node,
      el('div', { class: 'bar', style: 'position:static;background:none;margin-top:6px' }, [button, status]),
    ]));
    box.appendChild(el('div', { class: 'card' }, [el('h2', { class: 'card__title', text: 'Что происходит' }), log]));

    api('/api/overview').then(function (data) {
      [['Товаров всего', data.products], ['Показываются', data.shown],
       ['Скрыты вручную', data.hidden], ['Без фотографии', data.noPhoto]]
        .forEach(function (pair) {
          stats.appendChild(el('div', { class: 'stat' }, [
            el('div', { class: 'stat__n', text: String(pair[1]) }),
            el('div', { class: 'stat__t', text: pair[0] }),
          ]));
        });
    });

    function watch() {
      clearInterval(state.publishTimer);
      state.publishTimer = setInterval(tick, 1200);
      tick();
    }

    function tick() {
      api('/api/publish').then(function (data) {
        if (data.log && data.log.length) {
          log.textContent = data.log.join('\n');
          log.scrollTop = log.scrollHeight;
        }
        status.className = 'state ' + (data.running ? 'state--run' : data.ok === true ? 'state--ok' : data.ok === false ? 'state--bad' : '');
        status.lastChild.textContent = data.running ? 'Собираем…'
          : data.ok === true ? 'Опубликовано' : data.ok === false ? 'Не получилось' : 'Готово к публикации';
        button.disabled = data.running;
        if (!data.running) {
          clearInterval(state.publishTimer);
          state.publishTimer = null;
        }
      }).catch(function () {
        clearInterval(state.publishTimer);
        state.publishTimer = null;
        button.disabled = false;
      });
    }

    // Публикация могла быть запущена раньше и всё ещё идти — подхватываем её.
    tick();
  }

  // ==========================================================================
  // Маршруты
  // ==========================================================================

  function parseHash() {
    var parts = (location.hash || '#/products').replace(/^#\/?/, '').split('/');
    var name = parts[0] || 'products';
    return { name: name, id: parts[1] ? decodeURIComponent(parts[1]) : null };
  }

  function render() {
    clearInterval(state.publishTimer);
    state.publishTimer = null;

    state.route = parseHash();
    if (state.route.name === 'products' && state.route.id) return screenProduct(state.route.id);
    if (state.route.name === 'products') return screenProducts();
    if (state.route.name === 'sections') return screenSections();
    if (state.route.name === 'texts' && state.route.id) return screenText(state.route.id);
    if (state.route.name === 'texts') return screenTexts();
    if (state.route.name === 'contacts') return screenContacts();
    if (state.route.name === 'publish') return screenPublish();
    location.hash = '#/products';
  }

  // Разделы нужны почти каждому экрану (фильтр, выбор при создании,
  // собственный список) — читаем один раз при входе.
  function start() {
    api('/api/sections').then(function (sections) {
      state.sections = sections;
      render();
    }).catch(function (e) { toast(e.message, true); });
  }

  window.addEventListener('hashchange', render);

  api('/api/session').then(function (data) {
    if (data.authed) start();
    else screenLogin();
  }).catch(function () { screenLogin(); });
})();
