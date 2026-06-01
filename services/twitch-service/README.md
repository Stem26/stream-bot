# Twitch Service

Twitch service отвечает за чат-бота канала, EventSub-мониторинг стрима, веб-админку, игровые команды и интеграции с Telegram, PostgreSQL, DonateX и overlay.

## Что делает

- Подключается к Twitch-чату и обрабатывает команды: дуэли, очки, топы, `!dick`, `!крыса`, `!милашка`, `!партия`, ссылки, кастомные команды и счётчики.
- Поднимает EventSub WebSocket и отслеживает `stream.online`, `stream.offline`, `channel.follow`, `channel.raid`.
- Отправляет Telegram-уведомления о старте/конце стрима и статистику стрима.
- Ведёт статистику игроков, дуэлей, очков, зрителей, истории стримов и настроек в PostgreSQL.
- Запускает веб-интерфейс админки на Express/Vite (`/api/admin/...`, `/ws`).
- Интегрируется с DonateX: REST backfill/reconcile, SignalR, таблицы `donatex_*`.
- Синхронизирует отдельные события с overlay API.

## Важные переменные окружения

Сервис в production читает `.env` из корня монорепозитория. В development дополнительно используется `.env.local`.

```env
BOT_TOKEN=telegram_bot_token
CHANNEL_ID=telegram_channel_id
CHAT_ID=telegram_admin_chat_id

TWITCH_CHANNEL=kunilika666
TWITCH_CLIENT_ID=twitch_client_id
TWITCH_ACCESS_TOKEN=oauth_token_for_chat_bot_account
TWITCH_REFRESH_TOKEN=optional_refresh_token
BROADCAST_TWITCH_ACCESS_TOKEN=oauth_token_for_streamer_account

DATABASE_URL=postgres_connection_url
DONATEX_EXTERNAL_TOKEN=donatex_api_token
DONATEX_DATABASE_URL=optional_separate_donatex_db_url
DONATEX_RECONCILE_INTERVAL_MS=600000
DONATEX_BACKFILL_ON_START=true

STREAMER_USERNAME=kunilika666
ENABLE_BOT_FEATURES=true
ALLOW_LOCAL_COMMANDS=false
```

`TWITCH_ACCESS_TOKEN` должен принадлежать аккаунту, который пишет в чат от имени бота. Логин этого аккаунта берётся через Twitch OAuth validate, а не из отдельной переменной.

## Команды разработки

Из корня монорепозитория:

```bash
npm run dev:twitch
npm run build:twitch
npm run start:twitch
npm run twitch:token:check
npm run db:migrate:twitch
npm run db:migrate-data:twitch
```

Из папки сервиса:

```bash
npm run dev
npm run build
npm run start
npm run test:run
npm run twitch:token:check
npm run eventsub:cleanup
```

## Production

Основной entrypoint после сборки:

```bash
node dist/src/main.js
```

В PM2 сервис обычно запущен как `twitch-bot` через корневой `ecosystem.config.js`:

```bash
pm2 restart twitch-bot --update-env
pm2 logs twitch-bot --lines 100
```

Для DonateX диагностики смотри маркеры `[DONATEX]`, `DONATEX_SIGNALR`, `Backfill`, `Reconcile`.

## Структура

```text
twitch-service/
  src/
    main.ts                 # точка входа сервиса
    commands/               # Twitch игровые и служебные команды
    config/                 # env/features
    database/               # PostgreSQL init/migrations
    services/               # Twitch chat, EventSub, DonateX, overlay, storage
    web/                    # Express API и админка
    scripts/                # служебные проверки и админские скрипты
```
