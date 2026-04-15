## Деплой на сервер (первый раз)

### 1. Подготовка
```bash
cd /root/stream-bot
git pull origin main
npm install
```

### 2. Переменные окружения
Создайте `.env` в корне проекта с продакшн-токенами (BOT_TOKEN, Twitch credentials и т.д.). Файл `.env` в .gitignore — не попадёт в репозиторий.

### 3. База данных PostgreSQL
БД на сервере 194.87.55.131. В `.env` укажи `DATABASE_URL`:
```
DATABASE_URL=postgresql://root:ПАРОЛЬ@194.87.55.131:5432/stream_bot
```

**На сервере — создать БД (если ещё нет):**
```bash
sudo -u postgres psql -c "CREATE DATABASE stream_bot;"
# Или если используешь пользователя root:
# createdb -h localhost -U postgres stream_bot
```

**Создать таблицы:**
```bash
cd /root/stream-bot
npm run db:migrate --workspace services/telegram-service
npm run db:migrate --workspace services/twitch-service
```

**Если есть бэкапы JSON** (players.json, twitch-players.json, stream-history.json) — скопируйте их в корень и импортируйте:
```bash
npm run db:migrate-data --workspace services/telegram-service
npm run db:migrate-data --workspace services/twitch-service
```

### 4. Сборка и запуск
```bash
npm run build:telegram
npm run build:twitch
pm2 start ecosystem.config.js
pm2 save
```

---

## Nginx: защита админки (без пароля — ничего не грузится)

Чтобы без ввода пароля **ни страница админки, ни данные** не подгружались, nginx должен возвращать **401 до** отдачи HTML и до проксирования админских API.

**1. Создать файл паролей** (пароль должен совпадать с `ADMIN_PASSWORD` в .env):
```bash
sudo htpasswd -c /etc/nginx/.htpasswd_admin admin
# ввести пароль (тот же, что ADMIN_PASSWORD)
```

**2. В конфиге nginx** — отдельные `location` для админки и админских API с `auth_basic`:

```nginx
# Страница админки — без пароля отдаём 401, HTML не отдаётся
location = /admin {
    auth_basic "Admin Area";
    auth_basic_user_file /etc/nginx/.htpasswd_admin;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;  # передать Basic в приложение
}

# Админские API — без пароля 401, данные не подтягиваются
location ~ ^/api/(admin|commands|links|counters|party) {
    auth_basic "Admin Area";
    auth_basic_user_file /etc/nginx/.htpasswd_admin;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
}
```

**Итог:** при переходе на `/admin` без пароля nginx сразу отдаёт 401 и диалог входа; HTML и JS не отдаются, запросы к API не уходят — ничего не грузится и не отрисовывается. После ввода пароля браузер подставляет Basic в запросы, приложение принимает его и отдаёт данные.

---

## Управление ботами на сервере

### Статус и логи
```bash
pm2 list                    # Статус всех ботов
pm2 logs                    # Логи всех ботов
pm2 logs telegram-bot       # Логи только Telegram бота
pm2 logs twitch-bot         # Логи только Twitch бота
```

### Перезапуск
```bash
pm2 restart all             # Перезапустить оба бота
pm2 restart telegram-bot    # Только Telegram бот
pm2 restart twitch-bot      # Только Twitch бот
```

### Остановка/Запуск
```bash
pm2 stop telegram-bot       # Остановить
pm2 start telegram-bot      # Запустить
```

---

## Локальная разработка

### Запуск ботов локально (dev режим)

**⚠️ Важно:** Используйте `.env.local` файлы с **тестовым** токеном, чтобы не конфликтовать с продакшн ботом на сервере!

**Запустить Telegram бот:**
```bash
cd D:\Projects\stream-bot
npm run dev:telegram

```

**Запустить Twitch бот:**
```bash
npm run dev:twitch
```

**Запустить оба бота одновременно** (в разных терминалах):
```bash
# Терминал 1
npm run dev:telegram

# Терминал 2
npm run dev:twitch
```

### Сборка локально
```bash
npm run build:telegram    # Собрать Telegram бот
npm run build:twitch      # Собрать Twitch бот
```

---

## Обновление бота

### 1. Локально
```bash
git add .
git commit -m "описание изменений"
git push
```

### 2. На сервере

**Фон (fon.webp):** в репозитории должен быть закоммичен `services/twitch-service/src/web/ui/public/assets/fon.webp` (~130 KB). Тогда на сервере при `git pull` и `npm run build:twitch` сжатый фон попадёт в сборку без установки sharp и без исходного fon.png. Путь в коде менять не нужно — везде уже используется `/assets/fon.webp`.

**Проверка фона на сервере (если грузится долго — возможно отдаётся старый fon.png):**
```bash
# ВАЖНО: сборку запускать из КОРНЯ репозитория, не из services/twitch-service
cd /root/stream-bot

# Если git pull ругается на package-lock.json:
git stash
git pull origin main
git stash pop

npm install
npm run build:twitch

# Проверка: в сборке должен появиться fon.webp (~130 KB). Если есть fon.png — скрипт optimize:fon создаст fon.webp из него
ls -la services/twitch-service/dist/src/web/public/assets/fon.*
grep -o 'fon\.[a-z]*' services/twitch-service/dist/src/web/public/index.html

pm2 restart twitch-bot
```

В браузере после деплоя: жёсткое обновление (Ctrl+Shift+R) или инкогнито; в Network смотреть, какой файл грузится — должен быть fon.webp ~130 KB.

**Первый запуск (или после удаления из PM2):**
```bash
cd /root/stream-bot
git pull origin main
npm install
npm run db:migrate --workspace services/telegram-service
npm run db:migrate --workspace services/twitch-service
npm run build:telegram
npm run build:twitch
pm2 start ecosystem.config.js
pm2 save
```

**Обновить оба бота:**
```bash
cd /root/stream-bot
git pull origin main
npm install
npm run db:migrate --workspace services/telegram-service
npm run db:migrate --workspace services/twitch-service
npm run build:telegram
npm run build:twitch
pm2 restart all
pm2 logs --lines 50
```

**Обновить только Telegram бот:**
```bash
cd /root/stream-bot
git pull origin main
npm i``
npm run build:telegram
pm2 restart telegram-bot
pm2 logs telegram-bot --lines 50
```

**Обновить только Twitch бот:**
```bash
cd /root/stream-bot
git pull origin main
npm install
npm run build:twitch
pm2 restart twitch-bot
pm2 logs twitch-bot --lines 50

Что бы отправилось уведомление
cd /root/stream-bot
TELEGRAM_FORCE_STREAM_ONLINE_ON_STARTUP=1 pm2 restart twitch-bot --update-env
pm2 logs twitch-bot --lines 80
```
```aiignore
cd D:\Projects\stream-bot\services\twitch-service
npm run build:web
npm run build
npm start
npm run dev:all

node scripts/delete-telegram-messages.js 1 -1001234567890 123456:8549936481:AAF7h4s6k80syWbzgVsk1dwn3YV0J4Hb7OE

добавить пользователя htpasswd /etc/nginx/.htpasswd user2
проверить пользователей cat /etc/nginx/.htpasswd
http://localhost:3000/debug/overlay-triggers

В файле событий (главное место для диагностики): /root/stream-bot/logs/events.log
Удобные фильтры на сервере:
tail -n 200 /root/stream-bot/logs/events.log | grep -E "TELEGRAM_STREAM_ONLINE_|STREAM_ONLINE|STREAM_ONLINE_RECOVERED|EVENTSUB_NOTIFICATION|STREAM_STATUS_PROBE"

```
---
#cd /root/stream-bot
#node scripts/test-telegram.js
Отправка уведомления об окончании стрима вручную:
node scripts/send-stream-end.js

## Прочее

```bash
# Nightbot команда
npm run nightbot:send -- "@Kunilika666 милый стример"
npm run twitch:announcement:test "@Kunilika666 милый стример"

# Прод канал ID: -1001983402471
# Команды: /dick /top_dick /bottom_dick
# Twitch: !dick !top_dick !bottomdick !vanish
# ssh -v -N -D 127.0.0.1:1080 root@194.87.55.131
# kunikoka666


cd /d D:\Projects\alltalk_tts
start_alltalk.bat
```


```bash
              идеи: 
дуэль может уебать двоих +
спасти из маймача ?
снять таймач со всех +
стопдуэли не влияют на стримера и тех кто пойдёт к нему в очередь +
вызывать на дуэли индивидуально +
добавить все ссылки в тг бота +
Добавить в бота создание клипов ?
перенести партию
добавить хорни +
добавить фурри +
добавить веб интерфес куда можно будет добавлять новые команды и ссылки к ним менять если поменялась ссылка итд
реализовать возможность рандомной установки в чат +
добавить шатаут от рейдов

попробовать отрабатывать команды 
channel:manage:redemptions	Управляйте пользовательскими наградами Channel Points и их использованием на канале.
```