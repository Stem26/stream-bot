# Telegram Service

Telegram service отвечает за отдельного Telegram-бота с игровыми командами, публикациями в канал и PostgreSQL-хранилищем игроков.

## Что делает

- Запускает Telegraf-бота через polling.
- Регистрирует команды Telegram: `/dick`, `/top_dick`, `/bottom_dick`, `/future`, `/horny`, `/furry`, `/post`.
- Хранит состояние игроков и результатов в PostgreSQL.
- Поддерживает список админов для служебных команд.
- При запуске сбрасывает старые pending updates, чтобы бот не обрабатывал накопленные сообщения после простоя.
- Корректно закрывает соединение с БД при `SIGINT`/`SIGTERM`.

## Важные переменные окружения

Сервис читает `.env` из корня монорепозитория в production и `.env.local` в development.

```env
BOT_TOKEN=telegram_bot_token
CHANNEL_ID=telegram_channel_id
ALLOWED_ADMINS=123456789,987654321
STREAMER_USER_ID=1087968824,7166108463
DATABASE_URL=postgres_connection_url
```

`STREAMER_USER_ID` можно указать списком через запятую. Если переменная не задана, используются значения по умолчанию из `src/config/env.ts`.

## Команды разработки

Из корня монорепозитория:

```bash
npm run dev:telegram
npm run build:telegram
npm run start:telegram
npm run db:migrate:telegram
```

Из папки сервиса:

```bash
npm run dev
npm run build
npm run start
npm run test:run
npm run db:migrate
npm run db:migrate-data
```

## Production

Основной entrypoint после сборки:

```bash
node dist/main.js
```

В PM2 сервис обычно запущен как `telegram-bot` через корневой `ecosystem.config.js`:

```bash
pm2 restart telegram-bot --update-env
pm2 logs telegram-bot --lines 100
```

## Структура

```text
telegram-service/
  src/
    main.ts              # точка входа
    app/                 # создание бота, middleware, handlers, регистрация команд
    commands/            # Telegram-команды
    database/            # PostgreSQL init/migrations
    domain/              # доменная логика игр
    services/            # storage и прикладные сервисы
    types/               # типы контекста и конфигурации
    utils/               # форматирование, даты, permissions, logger
```
