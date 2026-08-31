/* ==========================================================================
   Корзина и избранное
   ==========================================================================
   Корзина и избранное живут в localStorage — своего хранилища на сервере
   у них нет. Отправка заказа (форма на /cart/) — единственное место, где
   скрипт стучится на сервер: POST /api/order в admin/api.mjs пересылает
   письмом то, что видит здесь, дальше сервер не хранит.
   Скрипт подключён в общей шапке и потому есть на каждой странице: счётчики
   у иконок, выдвижная панель корзины и разметка страниц /cart/ и /favorites/
   собираются здесь же.

   Товар описывается data-атрибутами на элементе [data-product] — id, название,
   цена, картинка и адрес. Кнопки внутри него (data-add, data-fav, data-share)
   ищут этот контейнер вверх по дереву, так что одна и та же разметка работает
   и в карточке каталога, и на странице товара.

   Пути к картинке и странице в data-атрибутах — всегда от корня сайта:
   корзина рисуется на страницах разной глубины, и относительный путь
   из карточки раздела на /cart/ указывал бы в никуда.
   ========================================================================== */
(function () {
  'use strict';

  var CART = 'axelnn:cart';
  var FAV = 'axelnn:fav';

  // --- хранилище ----------------------------------------------------------
  // localStorage может быть недоступен (приватный режим Safari, отключённые
  // куки) — тогда работаем в памяти: корзина живёт до перезагрузки, но
  // страница не падает с исключением на каждом клике.
  var memory = {};

  function read(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return memory[key] || [];
    }
  }

  function write(key, list) {
    memory[key] = list;
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
    sync();
  }

  // --- утилиты ------------------------------------------------------------
  function money(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
  }

  function plural(n, one, few, many) {
    var d = n % 10, h = n % 100;
    if (d === 1 && h !== 11) return one;
    if (d >= 2 && d <= 4 && (h < 10 || h > 20)) return few;
    return many;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Ключ позиции — id плюс размер: один и тот же костюм в 128 и в 134 это
  // две строки заказа, а не «две штуки одного».
  function keyOf(item) {
    return item.id + (item.size ? '::' + item.size : '');
  }

  // Читает товар из data-атрибутов контейнера. Размер берётся из выбранного
  // переключателя внутри него, если он есть. Цена размера может отличаться
  // от цены товара (см. data-price у самого input) — раз выбрали размер,
  // берём цену именно его, а не общую цену товара.
  function productFrom(box) {
    if (!box) return null;
    var size = null;
    var price = Number(box.dataset.price) || 0;
    var checked = box.querySelector('input[name="size"]:checked');
    if (checked) {
      size = checked.value;
      if (checked.dataset.price) price = Number(checked.dataset.price) || price;
    } else if (box.dataset.size) {
      size = box.dataset.size;
    }
    return {
      id: box.dataset.id,
      name: box.dataset.name || '',
      price: price,
      img: box.dataset.img || '',
      url: box.dataset.url || '',
      size: size,
      qty: 1,
    };
  }

  // --- корзина ------------------------------------------------------------
  function addToCart(item) {
    var list = read(CART);
    var key = keyOf(item);
    var hit = null;
    for (var i = 0; i < list.length; i++) if (keyOf(list[i]) === key) hit = list[i];
    if (hit) hit.qty += item.qty || 1;
    else list.push(item);
    write(CART, list);
    if (window.ym) ym(112096375, 'reachGoal', 'add_to_cart');
  }

  function setQty(key, qty) {
    var list = read(CART).filter(function (it) {
      if (keyOf(it) !== key) return true;
      it.qty = qty;
      return qty > 0;
    });
    write(CART, list);
  }

  function cartTotal(list) {
    return list.reduce(function (sum, it) { return sum + (it.price || 0) * it.qty; }, 0);
  }

  function cartCount(list) {
    return list.reduce(function (n, it) { return n + it.qty; }, 0);
  }

  // --- избранное ----------------------------------------------------------
  function inFav(id) {
    return read(FAV).some(function (it) { return it.id === id; });
  }

  function toggleFav(item) {
    var list = read(FAV);
    var next = list.filter(function (it) { return it.id !== item.id; });
    var added = next.length === list.length;
    if (added) next.push(item);
    write(FAV, next);
    if (added && window.ym) ym(112096375, 'reachGoal', 'add_to_fav');
    return added;
  }

  // --- уведомление --------------------------------------------------------
  var toastTimer = null;

  function toast(text, link) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.innerHTML = '<span>' + esc(text) + '</span>' +
      (link ? '<a href="' + esc(link.href) + '">' + esc(link.text) + '</a>' : '');
    el.hidden = false;
    // Класс вешаем следующим кадром: без этого переход от hidden к видимому
    // происходит в одной перерисовке и анимация появления не проигрывается.
    requestAnimationFrame(function () { el.classList.add('toast--on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('toast--on');
      setTimeout(function () { el.hidden = true; }, 250);
    }, 3200);
  }

  // --- панель корзины -----------------------------------------------------
  var drawer = null;

  function openDrawer() {
    drawer = drawer || document.getElementById('cart-drawer');
    if (!drawer) return;
    drawer.hidden = false;
    requestAnimationFrame(function () { drawer.classList.add('drawer--on'); });
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('drawer--on');
    document.body.style.overflow = '';
    setTimeout(function () { if (drawer && !drawer.classList.contains('drawer--on')) drawer.hidden = true; }, 250);
  }

  // --- поиск ---------------------------------------------------------------
  // Индекс (assets/search.json, см. tools/build-search.mjs) — только видимые
  // на сайте товары, без размеров и галереи. Подгружается лениво, при первом
  // открытии поиска: тянуть 300 КБ ради значка в шапке на каждой странице
  // незачем, а второе открытие уже возьмёт индекс из памяти.
  var search = null, searchInput = null, searchBody = null;
  var searchIndex = null, searchLoading = null;

  function loadSearchIndex() {
    if (searchIndex) return Promise.resolve(searchIndex);
    if (!searchLoading) {
      searchLoading = fetch('/assets/search.json')
        .then(function (r) { return r.json(); })
        .then(function (data) { searchIndex = data; return data; })
        .catch(function () { searchLoading = null; return []; });
    }
    return searchLoading;
  }

  function openSearch() {
    search = search || document.getElementById('search-overlay');
    searchInput = searchInput || document.getElementById('search-input');
    searchBody = searchBody || document.getElementById('search-results');
    if (!search) return;
    search.hidden = false;
    requestAnimationFrame(function () { search.classList.add('search-overlay--on'); });
    document.body.style.overflow = 'hidden';
    // iOS клавиатура сама раздвигает вьюпорт и подбрасывает overlay, если
    // фокус ставить синхронно с открытием — маленькая задержка снимает дёрг.
    setTimeout(function () { searchInput.focus(); }, 60);
    loadSearchIndex();
  }

  function closeSearch() {
    if (!search) return;
    search.classList.remove('search-overlay--on');
    document.body.style.overflow = '';
    setTimeout(function () { if (search && !search.classList.contains('search-overlay--on')) search.hidden = true; }, 200);
  }

  function searchResultRow(p, active) {
    var price = p.price ? (p.priceFrom ? 'от ' : '') + money(p.price) : 'Цена по запросу';
    var cat = (p.cat || '').split('/').pop();
    return '<a class="search-result' + (active ? ' is-active' : '') + '" href="' + esc(p.url) + '">' +
      '<span class="search-result__media">' + (p.img ? '<img src="/' + esc(p.img) + '" alt="" loading="lazy">' : '') + '</span>' +
      '<span class="search-result__body">' +
        '<span class="search-result__name">' + esc(p.name) + '</span>' +
        (cat ? '<span class="search-result__cat">' + esc(cat) + '</span>' : '') +
      '</span>' +
      '<span class="search-result__price">' + price + '</span>' +
    '</a>';
  }

  // Слова запроса ищем по отдельности («edea коньки» находит «Коньки Edea…»
  // не только при точном порядке слов) — по названию, бренду, категории
  // и артикулу разом.
  function searchMatch(q, p) {
    var hay = (p.name + ' ' + (p.brand || '') + ' ' + p.cat + ' ' + p.id).toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  function runSearch(raw) {
    var q = raw.trim().toLowerCase();
    if (!q) {
      searchBody.innerHTML = '<p class="search-hint">Начните вводить название, бренд или артикул товара.</p>';
      return;
    }
    loadSearchIndex().then(function (index) {
      // Пока грузился индекс, человек мог напечатать ещё — запрос устарел.
      if (searchInput.value.trim().toLowerCase() !== q) return;
      var matches = index.filter(function (p) { return searchMatch(q, p); });
      // Совпадение в начале названия — выше совпадения где-то в середине.
      matches.sort(function (a, b) {
        var an = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        var bn = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        return an - bn;
      });
      if (!matches.length) {
        searchBody.innerHTML = '<p class="search-hint">Ничего не нашлось. Проверьте название или позвоните — подскажем: ' +
          '<a href="tel:+79290534796">+7 929 053-47-96</a>.</p>';
        return;
      }
      searchBody.innerHTML = matches.slice(0, 30).map(function (p, i) { return searchResultRow(p, i === 0); }).join('');
    });
  }

  // Строка товара в панели и на странице корзины — разметка одна.
  function cartRow(it) {
    var key = keyOf(it);
    var media = it.img
      ? '<img src="' + esc(it.img) + '" alt="" loading="lazy">'
      : '<span class="ph"></span>';
    return [
      '<div class="crow" data-key="' + esc(key) + '">',
      '  <a class="crow__media" href="' + esc(it.url) + '">' + media + '</a>',
      '  <div class="crow__body">',
      '    <a class="crow__name" href="' + esc(it.url) + '">' + esc(it.name) + '</a>',
      it.size ? '    <span class="crow__size">Размер: ' + esc(it.size) + '</span>' : '',
      '    <div class="crow__row">',
      '      <div class="qty">',
      '        <button type="button" class="qty__btn" data-qty="-1" aria-label="Убавить">−</button>',
      '        <span class="qty__val">' + it.qty + '</span>',
      '        <button type="button" class="qty__btn" data-qty="1" aria-label="Прибавить">+</button>',
      '      </div>',
      '      <span class="crow__price">' + (it.price ? money(it.price * it.qty) : 'по запросу') + '</span>',
      '    </div>',
      '  </div>',
      '  <button type="button" class="crow__del" data-del aria-label="Убрать из корзины">',
      '    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>',
      '  </button>',
      '</div>',
    ].filter(Boolean).join('\n');
  }

  function renderDrawer(list) {
    var body = document.getElementById('cart-drawer-body');
    var foot = document.getElementById('cart-drawer-foot');
    if (!body) return;
    if (!list.length) {
      body.innerHTML = '<p class="drawer__empty">Пока пусто. Загляните в <a href="/catalog/">каталог</a> —' +
        ' там больше тысячи товаров для фигурного катания.</p>';
      if (foot) foot.hidden = true;
      return;
    }
    body.innerHTML = list.map(cartRow).join('\n');
    if (foot) {
      foot.hidden = false;
      setTotals(foot, cartTotal(list));
    }
  }

  // Сумма выводится дважды («Товары» и «Итого» в блоке заказа), поэтому
  // обновляем все ячейки, а не первую попавшуюся.
  function setTotals(box, sum) {
    box.querySelectorAll('[data-cart-total]').forEach(function (el) {
      el.textContent = money(sum);
    });
  }

  // --- страницы /cart/ и /favorites/ --------------------------------------
  function renderCartPage(list) {
    var box = document.getElementById('cart-page');
    if (!box) return;
    var foot = document.getElementById('cart-page-foot');
    var head = document.getElementById('cart-page-count');

    if (head) {
      head.textContent = list.length
        ? cartCount(list) + ' ' + plural(cartCount(list), 'товар', 'товара', 'товаров')
        : '';
    }
    if (!list.length) {
      box.innerHTML = '<p class="catalog-empty">Корзина пуста. Выберите что-нибудь в ' +
        '<a href="/catalog/">каталоге</a> — коньки, термокостюмы, чехлы и сумки.</p>';
      if (foot) foot.hidden = true;
      return;
    }
    box.innerHTML = list.map(cartRow).join('\n');
    if (foot) {
      foot.hidden = false;
      setTotals(foot, cartTotal(list));
    }
  }

  // Состав заказа простым текстом — можно скопировать и прислать в мессенджер
  // или продиктовать по телефону, если форма ниже почему-то не отправляется.
  function orderText(list) {
    var lines = list.map(function (it, i) {
      return (i + 1) + '. ' + it.name + (it.size ? ', размер ' + it.size : '') +
        ' — ' + it.qty + ' шт' + (it.price ? ' × ' + money(it.price) : '');
    });
    lines.push('Итого: ' + money(cartTotal(list)));
    return 'Заказ в Аксель·НН\n' + lines.join('\n');
  }

  // --- отправка заказа на почту --------------------------------------------
  function sendOrder(form) {
    var list = read(CART);
    if (!list.length) return;

    var phone = form.phone.value.trim();
    if (!phone) {
      form.phone.focus();
      toast('Укажите телефон для связи');
      return;
    }

    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';

    fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.value.trim(),
        phone: phone,
        company: form.company.value,
        items: list.map(function (it) {
          return { id: it.id, name: it.name, size: it.size, qty: it.qty, price: it.price, url: it.url };
        }),
      }),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.data && res.data.error) || 'Не получилось отправить заказ');
        write(CART, []);
        form.reset();
        toast('Заказ отправлен — мы свяжемся с вами');
        if (window.ym) ym(112096375, 'reachGoal', 'order_submit');
      })
      .catch(function (err) {
        toast(err.message || 'Не получилось отправить, позвоните нам');
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Отправить заказ';
      });
  }

  function favCard(it) {
    var media = it.img
      ? '<img class="ph" src="' + esc(it.img) + '" alt="' + esc(it.name) + '" loading="lazy">'
      : '<span class="ph"></span>';
    return [
      '<div class="card" data-product data-id="' + esc(it.id) + '" data-name="' + esc(it.name) + '"',
      '     data-price="' + (it.price || 0) + '" data-img="' + esc(it.img) + '" data-url="' + esc(it.url) + '">',
      '  <a class="card__link" href="' + esc(it.url) + '">',
      '    <div class="card__media card__media--fill">' + media + '</div>',
      '    <span class="card__name">' + esc(it.name) + '</span>',
      '    <div class="card__prices"><span class="card__price">' +
           (it.price ? money(it.price) : 'Цена по запросу') + '</span></div>',
      '  </a>',
      '  <div class="card__actions">',
      '    <button type="button" class="card__buy" data-add>В корзину</button>',
      '    <button type="button" class="card__fav is-on" data-fav aria-label="Убрать из избранного">',
      '      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M12 20.5 4.4 12.9a4.6 4.6 0 0 1 6.5-6.5l1.1 1.1 1.1-1.1a4.6 4.6 0 0 1 6.5 6.5L12 20.5Z"/></svg>',
      '    </button>',
      '  </div>',
      '</div>',
    ].join('\n');
  }

  function renderFavPage(list) {
    var box = document.getElementById('fav-page');
    if (!box) return;
    var head = document.getElementById('fav-page-count');
    if (head) {
      head.textContent = list.length
        ? list.length + ' ' + plural(list.length, 'товар', 'товара', 'товаров')
        : '';
    }
    if (!list.length) {
      box.innerHTML = '<p class="catalog-empty">В избранном пусто. Нажмите на сердечко у товара, ' +
        'чтобы вернуться к нему позже.</p>';
      box.classList.remove('cards-grid');
      return;
    }
    box.classList.add('cards-grid');
    box.innerHTML = list.map(favCard).join('\n');
  }

  // --- общий пересчёт -----------------------------------------------------
  function sync() {
    var cart = read(CART);
    var fav = read(FAV);

    var n = cartCount(cart);
    document.querySelectorAll('[data-cart-count]').forEach(function (el) {
      el.textContent = n;
      el.hidden = n === 0;
    });
    document.querySelectorAll('[data-fav-count]').forEach(function (el) {
      el.textContent = fav.length;
      el.hidden = fav.length === 0;
    });

    // Сердечки на карточках: состояние приходит из хранилища, а не из клика —
    // иначе после возврата «назад» страница показывала бы пустые сердца
    // на уже отложенных товарах.
    document.querySelectorAll('[data-product]').forEach(function (box) {
      var btn = box.querySelector('[data-fav]');
      if (!btn) return;
      var on = fav.some(function (it) { return it.id === box.dataset.id; });
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное');
      btn.setAttribute('aria-pressed', String(on));
    });

    renderDrawer(cart);
    renderCartPage(cart);
    renderFavPage(fav);
  }

  // --- обработчики --------------------------------------------------------
  document.addEventListener('click', function (e) {
    var t = e.target;

    // Открыть/закрыть панель
    if (t.closest('#cart-open')) { e.preventDefault(); openDrawer(); return; }
    if (t.closest('[data-cart-close]')) { e.preventDefault(); closeDrawer(); return; }
    if (t.closest('#search-open')) { e.preventDefault(); openSearch(); return; }
    if (t.closest('[data-search-close]')) { e.preventDefault(); closeSearch(); return; }

    // Количество и удаление внутри строки корзины
    var qtyBtn = t.closest('[data-qty]');
    if (qtyBtn) {
      var row = qtyBtn.closest('.crow');
      var cur = read(CART).filter(function (it) { return keyOf(it) === row.dataset.key; })[0];
      if (cur) setQty(row.dataset.key, cur.qty + Number(qtyBtn.dataset.qty));
      return;
    }
    var del = t.closest('[data-del]');
    if (del) {
      setQty(del.closest('.crow').dataset.key, 0);
      return;
    }

    // В корзину
    var add = t.closest('[data-add]');
    if (add) {
      e.preventDefault();
      var box = add.closest('[data-product]');
      var item = productFrom(box);
      if (!item || !item.id) return;

      // Размер обязателен, если он у товара есть: без него заказ не собрать,
      // а молчаливое добавление «без размера» пришлось бы уточнять звонком.
      if (box.dataset.needSize === 'true' && !item.size) {
        var picker = box.querySelector('.sizes');
        if (picker) {
          picker.classList.add('sizes--ask');
          picker.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setTimeout(function () { picker.classList.remove('sizes--ask'); }, 1600);
        }
        toast('Выберите размер');
        return;
      }

      addToCart(item);
      add.classList.add('is-added');
      setTimeout(function () { add.classList.remove('is-added'); }, 1200);
      toast(item.name + ' — в корзине', { href: '/cart/', text: 'Оформить' });
      return;
    }

    // В избранное
    var fav = t.closest('[data-fav]');
    if (fav) {
      e.preventDefault();
      var favItem = productFrom(fav.closest('[data-product]'));
      if (!favItem || !favItem.id) return;
      delete favItem.qty;
      delete favItem.size;
      toast(toggleFav(favItem) ? 'Добавлено в избранное' : 'Убрано из избранного');
      return;
    }

    // Скопировать состав заказа
    if (t.closest('[data-copy-order]')) {
      e.preventDefault();
      var order = read(CART);
      if (!order.length) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(orderText(order))
          .then(function () { toast('Заказ скопирован — пришлите его нам'); })
          .catch(function () { toast('Не вышло скопировать, позвоните нам'); });
      } else {
        toast('Позвоните нам: +7 831 423-47-96');
      }
      return;
    }

    // Поделиться
    var share = t.closest('[data-share]');
    if (share) {
      e.preventDefault();
      var url = location.href;
      var title = document.title;
      if (navigator.share) {
        navigator.share({ title: title, url: url }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () { toast('Ссылка скопирована'); });
      } else {
        toast(url);
      }
    }
  });

  // Отправка заказа с телефоном и именем — форма только в блоке заказа
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('#order-form');
    if (!form) return;
    e.preventDefault();
    sendOrder(form);
  });

  // Выбор размера может сменить цену — до выбора в шапке товара показана
  // «от» самой дешёвой, а как только человек выбрал конкретный размер,
  // должна остаться его точная цена, без «от».
  document.addEventListener('change', function (e) {
    if (e.target.name !== 'size' || !e.target.dataset.price) return;
    var box = e.target.closest('[data-product]');
    var priceEl = box && box.querySelector('.product__price');
    if (priceEl) priceEl.textContent = money(Number(e.target.dataset.price));
  });

  // Не на каждое нажатие — список в тысячу товаров при вводе не должен мигать.
  var searchTyping = null;
  document.addEventListener('input', function (e) {
    if (e.target.id !== 'search-input') return;
    clearTimeout(searchTyping);
    var q = e.target.value;
    searchTyping = setTimeout(function () { runSearch(q); }, 150);
  });

  // Esc закрывает панель — с модальным диалогом это ожидаемое поведение.
  // Стрелки и Enter в поиске двигают подсветку по списку результатов —
  // после ввода запроса руки уже на клавиатуре, тянуться к мыши незачем.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (search && search.classList.contains('search-overlay--on')) { closeSearch(); return; }
      if (drawer && drawer.classList.contains('drawer--on')) closeDrawer();
      return;
    }

    if (!search || search.hidden || document.activeElement !== searchInput) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;

    var items = Array.prototype.slice.call(searchBody.querySelectorAll('.search-result'));
    if (!items.length) return;

    if (e.key === 'Enter') {
      var active = searchBody.querySelector('.search-result.is-active');
      if (active) location.href = active.href;
      return;
    }

    e.preventDefault();
    var idx = items.findIndex(function (a) { return a.classList.contains('is-active'); });
    idx = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
    items.forEach(function (a, i) { a.classList.toggle('is-active', i === idx); });
    items[idx].scrollIntoView({ block: 'nearest' });
  });

  // Соседняя вкладка положила товар в корзину — счётчик здесь должен об этом
  // узнать, иначе два открытых окна показывают разные суммы.
  window.addEventListener('storage', function (e) {
    if (e.key === CART || e.key === FAV) sync();
  });

  sync();
})();
