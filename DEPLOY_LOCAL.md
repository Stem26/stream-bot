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
```

---

## Прочее

```bash
# Nightbot команда
npm run nightbot:send -- "@Kunilika666 милый стример"
npm run twitch:announcement:test "@Kunilika666 милый стример"

# Прод канал ID: -1001983402471
# Команды: /dick /top_dick /bottomdick
# Twitch: !dick !top_dick !bottomdick !vanish
```