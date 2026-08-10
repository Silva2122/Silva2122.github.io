# Деплой на хостинг

Для разработчика, который разворачивает сайт на боевом сервере — не для владельца
магазина (у него [admin/README.md](../admin/README.md)).

Модель: свой VPS, `admin/server.mjs` работает постоянно как systemd-сервис и отдаёт
и сайт, и админку с одного и того же процесса (он же генерирует HTML в `catalog/`,
`company/` и т.д. — та же файловая структура, что и в репозитории). Публично сервер
не торчит: слушает `127.0.0.1:4180`, а порт 443 наружу держит nginx и проксирует
на него же. Так безопаснее, чем `--host 0.0.0.0` из комментария в `server.mjs` —
TLS и открытый порт держит nginx, у которого это единственная работа.

## Что нужно на сервере

- Ubuntu/Debian (или любой Linux с systemd)
- Node.js ≥ 18
- nginx, certbot (`sudo apt install nginx certbot python3-certbot-nginx`)
- git

## Шаги

**1. Своп — если на сервере 1 ГБ RAM или меньше**

Обработка фото через `sharp` и `npm ci` при обновлениях иногда просят памяти
больше, чем есть в простое. Без свопа сервер в такой момент может убить процесс
по OOM. Своп-файл — бесплатная страховка, места на диске для него достаточно:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

На тарифах от 2 ГБ RAM можно пропустить.

**2. Код на сервер**

```bash
sudo adduser --system --group --home /var/www/axelnn axelnn
sudo -u axelnn git clone https://github.com/Silva2122/Silva2122.github.io.git /var/www/axelnn
cd /var/www/axelnn
sudo -u axelnn npm ci --omit=dev
```

`--omit=dev` не ставит `playwright-core` и `@huggingface/transformers` — это
инструменты для скриншотов и обработки донора, на сервере не нужны. Ставится
только `sharp`, он же нужен `admin/images.mjs` в рантайме.

**3. Пароль владельца**

```bash
sudo -u axelnn node admin/server.mjs --set-password
```

Логин и пароль передайте владельцу отдельно от этой переписки (мессенджер, не почта
с историей чата) — заново узнать пароль нельзя, только сменить той же командой.

**4. Публикация на GitHub (необязательно)**

Кнопка «Опубликовать → Отправить на GitHub» в админке — это `git add/commit/push`
от имени пользователя `axelnn`. Если хотите, чтобы она работала (резервная копия
правок в репозитории), настройте git на сервере под этим пользователем:

```bash
sudo -u axelnn git config --global user.email "admin@axelnn.ru"
sudo -u axelnn git config --global user.name "Axelnn Admin"
# и доступ на push: deploy-ключ или PAT в credential helper
```

Если это не нужно — просто держите переключатель выключенным, сайт от этого
не перестанет работать: сервер отдаёт файлы с диска, GitHub тут ни при чём.

**5. systemd**

```bash
sudo cp deploy/axelnn-admin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now axelnn-admin
sudo systemctl status axelnn-admin
```

Поправьте в файле `WorkingDirectory`/`ExecStart`, если код лежит не в
`/var/www/axelnn`.

**6. nginx (пока без HTTPS)**

```bash
sudo cp deploy/nginx-axelnn.conf /etc/nginx/sites-available/axelnn
sudo ln -s /etc/nginx/sites-available/axelnn /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

В конфиге специально только 80-й порт: блок под 443 с несуществующим ещё
сертификатом уронил бы `nginx -t`, и сайт не поднялся бы вообще. Сайт уже
доступен по `http://IP-сервера/` — сертификат допишет certbot ниже.

**7. DNS**

A-запись `axelnn.ru` (и `www`) должна смотреть на IP этого сервера. Меняется
у текущего регистратора/хостера — это не в коде и делается отдельно, обычно
тем, у кого сейчас крутится Bitrix-версия. Смена вступает в силу не сразу
(TTL записи, обычно до нескольких часов). **Без этого шага certbot ниже
не сработает** — Let's Encrypt проверяет владение доменом, обращаясь на него
по HTTP, и до переключения DNS попадёт на старый Bitrix-хостинг, а не сюда.

**7.1. certbot — когда DNS уже смотрит на этот сервер**

```bash
sudo certbot --nginx -d axelnn.ru -d www.axelnn.ru
```

Сам допишет блок под 443 и сертификаты, переключит `location /` на редирект
с 80 на 443. Проверить: `sudo nginx -t && sudo systemctl reload nginx`
(certbot обычно делает reload сам).

**8. Проверка**

- `https://axelnn.ru/` — сайт
- `https://axelnn.ru/admin/` — вход в админку, куки теперь с флагом `Secure`
  (проверить: DevTools → Application → Cookies → `axelnn_admin` → Secure ✓)
- Зайти, поправить любой тестовый товар, нажать «Опубликовать», убедиться,
  что правка появилась на сайте

## Обновление кода

Правки владельца (товары, тексты, контакты) идут через админку и публикацию —
это не требует захода на сервер. А вот изменения самого кода (вёрстка, генераторы,
админка) выкладываются руками:

```bash
cd /var/www/axelnn
sudo -u axelnn git pull
sudo -u axelnn npm ci --omit=dev
sudo systemctl restart axelnn-admin
```

## Чего здесь ещё нет

Список содержательных пробелов — «Известные хвосты» в [CLAUDE.md](../CLAUDE.md#известные-хвосты)
(товары без фото скрыты, часть кадров без вырезанного фона, карусели на главной
не редактируются из админки). Это не блокирует запуск, но стоит проговорить
с владельцем до передачи.
