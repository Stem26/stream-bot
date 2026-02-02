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

## Обновление бота

### 1. Локально
```bash
git add .
git commit -m "описание изменений"
git push
```

### 2. На сервере

**Обновить оба бота:**
```bash
/root/stream-bot/update.sh
```

**Обновить только Telegram бот:**
```bash
cd /root/stream-bot
git pull origin main
npm install
npm run build:telegram
pm2 restart telegram-bot
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
npm run nightbot:send -- "@Kunilika666 текст"

# Прод канал ID: -1001983402471
# Команды: /dick /top_dick /bottomdick
# Twitch: !dick !top_dick !bottomdick !vanish
```