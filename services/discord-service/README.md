# Discord Service

Discord service отвечает за `discord-guard`: отдельный процесс, который держит Discord-бота в заданном голосовом канале и восстанавливает подключение, если бот был перемещён или отключился.

## Что делает

- Подключает Discord-бота через `discord.js`.
- Проверяет, что бот видит нужный сервер (`DISCORD_GUILD_ID`).
- Поддерживает присутствие в целевом голосовом канале (`DISCORD_VOICE_CHANNEL_ID`).
- Логирует вход, выход и перемещения бота между голосовыми каналами.
- Запускает health check и переподключение при потере голосового канала.
- Может оставаться в голосовом канале при остановке процесса или выходить из него, в зависимости от `DISCORD_GUARD_LEAVE_ON_STOP`.

## Важные переменные окружения

Сервис читает `.env`/`.env.local` сначала из корня монорепозитория, затем из папки `services/discord-service`. Значения из service-level env могут переопределить общие.

```env
DISCORD_BOT_TOKEN=discord_bot_token
DISCORD_GUILD_ID=discord_server_id
DISCORD_VOICE_CHANNEL_ID=target_voice_channel_id

DISCORD_GUARD_CHECK_INTERVAL_MS=60000
DISCORD_GUARD_RECONNECT_DELAY_MS=5000
DISCORD_GUARD_STATUS_LOG_INTERVAL_MS=900000
DISCORD_GUARD_LEAVE_ON_STOP=true
```

Боту нужны intents `Guilds` и `GuildVoiceStates`; в коде они задаются при создании клиента.

## Команды разработки

Из корня монорепозитория:

```bash
npm run dev:discord
npm run build:discord
npm run start:discord
```

Из папки сервиса:

```bash
npm run dev
npm run build
npm run start
npm run deploy
```

## Production

Основной entrypoint после сборки:

```bash
node dist/src/main.js
```

В PM2 сервис обычно запущен как `discord-guard` через корневой `ecosystem.config.js` или локальный deploy-script:

```bash
pm2 restart discord-guard --update-env
pm2 logs discord-guard --lines 100
```

## Структура

```text
discord-service/
  src/
    main.ts                    # точка входа
    config/env.ts              # загрузка DISCORD_* конфигурации
    services/VoiceChannelGuard.ts
    types/config.ts
    utils/logger.ts
    utils/consoleEncoding.ts
```
