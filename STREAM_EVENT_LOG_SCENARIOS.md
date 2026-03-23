# Stream Event Диагностика

Этот файл описывает, как читать логи стрима и почему бот может остаться в `offline`, даже если стрим уже идёт.

## Где смотреть

- Основной event-log: `logs/events.log`
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

- Периодический опрос раз в 30 сек, пока `isStreamOnline=false`
- Дополнительный триггер после `channel.follow` / `channel.raid` (с cooldown)

Новые типы в `events.log`:

- `STREAM_STATUS_PROBE` — результат fallback-проверки (`online=true/false`, `reason`)
- `STREAM_ONLINE_RECOVERED` — online восстановлен не через EventSub, а через fallback

## Как отличить причины

### 1) EventSub сработал штатно

Есть:

- `EVENTSUB_NOTIFICATION: stream.online`
- `STREAM_ONLINE`

### 2) EventSub online пропущен, но fallback спас

Есть:

- нет `EVENTSUB_NOTIFICATION: stream.online`
- есть `STREAM_STATUS_PROBE` с `online=true`
- есть `STREAM_ONLINE_RECOVERED`

### 3) И EventSub, и fallback не подняли online

Есть:

- `STREAM_STATUS_PROBE` только с `online=false`
- команды в чате режутся как offline

Проверь:

- токен (`TWITCH_ACCESS_TOKEN`) и актуальность прав
- стабильность EventSub websocket
- `helix/streams` ответы и ошибки в PM2 логах

## Быстрые команды для фильтра

```bash
pm2 logs 1 --lines 8000 --nostream | grep -E "stream.online|stream.offline|STREAM_ONLINE|STREAM_OFFLINE|STREAM_ONLINE_RECOVERED|STREAM_STATUS_PROBE|Session ID|Подписка на|Ошибка подписки|WebSocket|EVENTSUB_NOTIFICATION"
```

```bash
tail -n 500 logs/events.log | grep -E "STREAM_|EVENTSUB_"
```

