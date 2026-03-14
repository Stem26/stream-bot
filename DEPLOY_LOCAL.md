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
npm i
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
```
```aiignore
cd D:\Projects\stream-bot\services\twitch-service
npm run build:web
npm run build
npm start

добавить пользователя htpasswd /etc/nginx/.htpasswd user2
проверить пользователей cat /etc/nginx/.htpasswd
```
---

## Прочее

```bash
# Nightbot команда
npm run nightbot:send -- "@Kunilika666 милый стример"
npm run twitch:announcement:test "@Kunilika666 милый стример"

# Прод канал ID: -1001983402471
# Команды: /dick /top_dick /bottom_dick
# Twitch: !dick !top_dick !bottomdick !vanish
# ssh -v -N -D 127.0.0.1:1080 root@194.87.55.131


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
```