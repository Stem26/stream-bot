# Stream Event Диагностика

Этот файл описывает, как читать логи стрима и почему бот может остаться в `offline`, даже если стрим уже идёт.

## Где смотреть

- Основной event-log: `logs/events.log` (в старых деплоях может быть `events.log` в корне)
- PM2 stdout/stderr: `pm2 logs 1 --nostream --lines 8000`

## Нормальный сценарий старта

1. `EVENTSUB_WEBSOCKET` со `status=connected`
2. Логи `Подписка на stream.online создана` и `Подписка на stream.offline создана`
3. При реальном старте стрима:
   - `EVENTSUB_NOTIFICATION` с `type=stream.online`
   - `STREAM_ONLINE`

## Нормальный сценарий окончания

1. `EVENTSUB_NOTIFICATION` с `type=stream.offline`
2. `STREAM_OFFLINE`

## Если `stream.online` пропал

Бот теперь делает fallback-проверки через `helix/streams`:

- Периодический опрос раз в `30 сек`, пока `isStreamOnline=false` (`reason=timer:offline-poll`)
- Дополнительный триггер после `channel.follow` / `channel.raid` (`reason=event:channel.follow` / `event:channel.raid`)
- Cooldown для event-триггеров `15 сек` (чтобы не спамить Helix)

Типы в `events.log` для этой диагностики:

- `STREAM_STATUS_PROBE` — результат fallback-проверки (`online=true/false`, `reason`)
- `STREAM_ONLINE_RECOVERED` — online восстановлен не через EventSub, а через fallback
- `EVENTSUB_RAW` — сырые метаданные входящего EventSub сообщения:
  - `messageType`, `messageId`, `messageTimestamp`
  - `subscriptionType` (например, `stream.online`)
  - `sessionId`, `reconnectUrl`
  - `rawBytes`, `eventPreview`
- `ERROR` с `context=TwitchEventSubNative.MessageParse` — если raw-пакет не распарсился

## Как отличить причины

### 1) EventSub сработал штатно

Есть:

- `EVENTSUB_NOTIFICATION: stream.online`
- `STREAM_ONLINE`
- обычно рядом есть `EVENTSUB_RAW` с `subscriptionType=stream.online`

### 2) EventSub online пропущен, но fallback спас

Есть:

- нет `EVENTSUB_NOTIFICATION: stream.online`
- есть `STREAM_STATUS_PROBE` с `online=true`
- есть `STREAM_ONLINE_RECOVERED`
- при этом в `EVENTSUB_RAW` может не быть `subscriptionType=stream.online`, но будут другие типы (`channel.follow` и т.д.)

### 3) И EventSub, и fallback не подняли online

Есть:

- `STREAM_STATUS_PROBE` только с `online=false`
- команды в чате режутся как offline

Проверь:

- токен (`TWITCH_ACCESS_TOKEN`) и актуальность прав
- стабильность EventSub websocket
- `helix/streams` ответы и ошибки в PM2 логах

### 4) Twitch прислал `stream.online`, но код не обработал

Редко, но возможно при проблемном payload.

Есть:

- `EVENTSUB_RAW` с `subscriptionType=stream.online`
- **нет** `EVENTSUB_NOTIFICATION: stream.online`
- `ERROR` с `context=TwitchEventSubNative.MessageParse` или ошибка обработки сообщения рядом по времени

Это уже не проблема доставки, а парсинга/обработки входящего сообщения.

## Быстрые команды для фильтра

```bash
pm2 logs 1 --lines 8000 --nostream | rg "stream.online|stream.offline|STREAM_ONLINE|STREAM_OFFLINE|STREAM_ONLINE_RECOVERED|STREAM_STATUS_PROBE|Session ID|Подписка на|Ошибка подписки|WebSocket|EVENTSUB_NOTIFICATION|EVENTSUB_RAW|MessageParse"
```

```bash
tail -n 800 logs/events.log | rg "STREAM_|EVENTSUB_|MessageParse|checkCurrentStreamStatus"
```

## Как расширять orchestration-слой (кратко)

Когда добавляешь новый Twitch API сценарий (например, moderation/polls), придерживайся этого паттерна:

1. Добавь метод в `TwitchApiClient`, который возвращает `ApiCallResult<T>`.
2. В `TwitchEventSubNative` добавь новый ключ в `API_META`:
   - `skipEvent` — тип skip-лога для throttled/backoff кейсов
   - `errorContext` — стабильный контекст для `ERROR` логов
3. На call-site используй:
   - `const status = this.handleApiResult(result, { context: '<операция>', api: '<ключ>' })`
   - `if (status !== 'ok') return`
4. Успешный orchestration-путь (side effects, state updates, `recovered`-лог) оставляй в вызывающем методе, не в API клиенте.

Почему так:

- transport/retry/backoff остаются в `TwitchApiClient`
- policy логирования skip/fail централизована в `handleApiResult`
- orchestration-решения остаются в `TwitchEventSubNative`

