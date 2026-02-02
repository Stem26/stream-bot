# 🔄 Инструкция по переходу на монорепо

## Что делать дальше

### 1️⃣ Переместить код в services/

Вам нужно вручную переместить файлы:

```bash
# Telegram сервис
Переместить:  src/ → services/telegram-service/src/
Переместить:  tsconfig.json → services/telegram-service/tsconfig.json
Переместить:  nodemon.json → services/telegram-service/nodemon.json
Переместить:  .env.local → services/telegram-service/.env
Переместить:  players.json → services/telegram-service/players.json

# Twitch сервис
Переместить:  twitch-bot/src/ → services/twitch-service/src/
Переместить:  twitch-bot/tsconfig.json → services/twitch-service/tsconfig.json
Переместить:  twitch-bot/nodemon.json → services/twitch-service/nodemon.json
```

### 2️⃣ Обновить Twitch сервис для отправки в Telegram

**services/twitch-service/.env**
```env
# Добавить Telegram токен для отправки уведомлений
BOT_TOKEN=your_telegram_bot_token
CHANNEL_ID=-1001234567890

# Twitch настройки
TWITCH_CHANNEL=kunilika666
TWITCH_CLIENT_ID=your_client_id
TWITCH_ACCESS_TOKEN=your_access_token
NIGHTBOT_TOKEN=your_nightbot_token
```

**services/twitch-service/src/config/env.ts**
```typescript
export function loadConfig(): AppConfig {
  // Добавить BOT_TOKEN и CHANNEL_ID
  const botToken = process.env.BOT_TOKEN;
  const channelId = process.env.CHANNEL_ID;
  
  if (!botToken || !channelId) {
    throw new Error('BOT_TOKEN и CHANNEL_ID обязательны для отправки уведомлений!');
  }

  // ... rest
}
```

**services/twitch-service/src/services/twitch-stream-monitor.ts**
```typescript
import { Telegram } from 'telegraf';

// В конструкторе
constructor() {
  const botToken = process.env.BOT_TOKEN!;
  this.telegram = new Telegram(botToken);
}

// Метод уже готов для отправки уведомлений!
private async handleStreamOnline(event: any, telegramChannelId?: string) {
  await this.telegram.sendMessage(telegramChannelId, message, {
    parse_mode: 'HTML'
  });
}
```

### 3️⃣ Установить зависимости

```bash
# В корне проекта
npm install

# Это установит зависимости для всех сервисов
```

### 4️⃣ Собрать проекты

```bash
npm run build
```

### 5️⃣ Запустить в dev режиме

```bash
# Терминал 1
npm run dev:telegram

# Терминал 2
npm run dev:twitch
```

### 6️⃣ Обновить .gitignore

Добавьте в корневой `.gitignore`:

```gitignore
# Node modules
node_modules/
services/*/node_modules/

# Build output
dist/
services/*/dist/

# Environment variables
.env
.env.local
services/*/.env
services/*/.env.local

# Data files
*.json
!package.json
!package-lock.json
!tsconfig.json

# Old structure (можно удалить после переноса)
src/
twitch-bot/
```

### 7️⃣ Удалить старые файлы

После того как убедитесь, что всё работает:

```bash
# Удалить старую структуру
rm -rf src/
rm -rf twitch-bot/
rm package.json.old
rm tsconfig.json.old
```

### 8️⃣ Закоммитить изменения

```bash
git add .
git commit -m "refactor: migrate to monorepo with microservices architecture"
git push
```

## ✅ Проверка

После миграции проверьте:

- [ ] Telegram бот запускается: `npm run dev:telegram`
- [ ] Twitch бот запускается: `npm run dev:twitch`
- [ ] Telegram команды работают: `/dick`, `/top_dick`
- [ ] Twitch команды работают: `!dick`, `!top_dick`, `!vanish`
- [ ] Twitch отправляет уведомления в Telegram при начале стрима
- [ ] Данные игроков сохраняются в соответствующих файлах

## 🎉 Готово!

Теперь у вас монорепо с микросервисами, где:
- 🟦 **telegram-service** — чистый Telegram бот
- 🟪 **twitch-service** — Twitch бот с интеграцией Telegram
- 📦 **npm workspaces** — удобное управление зависимостями
- 🚀 **Независимый деплой** каждого сервиса
