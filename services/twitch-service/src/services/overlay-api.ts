import WebSocket from 'ws';

const OVERLAY_DUEL_COMPLETE_EVENT = 'App\\Events\\Game\\DuelCompleteEvent';
const OVERLAY_EVENTBUS_RECONNECT_MS = 1500;

function getOverlayApiBaseUrl(): string | undefined {
  return process.env.OVERLAY_API_BASE_URL;
}

function getOverlayApiToken(): string | undefined {
  return process.env.OVERLAY_API_TOKEN;
}

function getOverlayEventBusWsUrl(): string | undefined {
  return process.env.OVERLAY_EVENTBUS_WS_URL || process.env.OVERLAY_EVENTS_WS_URL;
}

function getOverlayDuelCompleteWaitMs(): number {
  return Math.max(1000, Number(process.env.OVERLAY_DUEL_COMPLETE_WAIT_MS || 30000));
}

type OverlayRequest = {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
};

async function callOverlay<T = unknown>(
  path: string,
  init: OverlayRequest = {}
): Promise<T> {
  const OVERLAY_API_BASE_URL = getOverlayApiBaseUrl();
  const OVERLAY_API_TOKEN = getOverlayApiToken();
  if (!OVERLAY_API_BASE_URL || !OVERLAY_API_TOKEN) {
    console.error(
      '⚠️ Overlay API не настроен: проверь OVERLAY_API_BASE_URL и OVERLAY_API_TOKEN в .env'
    );
    return undefined as T;
  }

  const url = `${OVERLAY_API_BASE_URL}${path}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${OVERLAY_API_TOKEN}`,
  };

  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(
      url,
      {
        method: init.method || 'GET',
        headers: {
          ...headers,
          ...(init.headers || {}),
        },
        body:
          init.body === undefined
            ? undefined
            : typeof init.body === 'string'
            ? init.body
            : JSON.stringify(init.body),
      } as RequestInit
    );
  } catch (error: any) {
    const cause = error?.cause ? `; cause: ${String(error.cause)}` : '';
    throw new Error(`Overlay fetch failed for ${url}: ${error?.message || error}${cause}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Overlay API error ${response.status}: ${response.statusText} ${text}`
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return (await response.json()) as T;
  }

  // На случай если ответ без тела или не JSON
  return undefined as T;
}

export async function triggerOverlayPlayer(
  nickname: string,
  role: OverlayTriggerRole = null
): Promise<void> {
  if (!nickname) return;

  try {
    const body = {
      type: 'twitch' as const,
      nickname,
      role,
    };
    await callOverlay('/game/trigger', {
      method: 'POST',
      body,
    });
  } catch (error: any) {
    console.error(
      '⚠️ Ошибка вызова Overlay /game/trigger:',
      error?.message || error
    );
  }
}

export type OverlayTriggerRole = null | 'vip' | 'moderator' | 'broadcaster';

export type DuelMode = 'a-win' | 'b-win' | 'all-win' | 'all-lose';

export async function sendOverlayDuelSafe(
  playerA: string,
  playerB: string,
  mode: DuelMode
): Promise<boolean> {
  if (!playerA || !playerB) return false;

  try {
    await callOverlay('/game/duel', {
      method: 'POST',
      body: {
        players: {
          a: {
            type: 'twitch',
            nickname: playerA,
          },
          b: {
            type: 'twitch',
            nickname: playerB,
          },
        },
        mode,
      },
    });
    return true;
  } catch (error: any) {
    console.error(
      '⚠️ Ошибка вызова Overlay /game/duel:',
      error?.message || error
    );
    return false;
  }
}

export async function sendOverlayDuel(
  playerA: string,
  playerB: string,
  mode: DuelMode
): Promise<void> {
  await sendOverlayDuelSafe(playerA, playerB, mode);
}

type OverlayEventPayload = {
  event?: string;
  data?: string | Record<string, unknown>;
  channel?: string;
};

function isPusherStyleUrl(url: string): boolean {
  return /\/app\/[^/?]+/i.test(url);
}

function parseOverlayEvent(raw: unknown): OverlayEventPayload | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as OverlayEventPayload;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function extractEventTimeSec(payload: OverlayEventPayload): number | null {
  const data = payload.data;
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as { time?: unknown };
      if (typeof parsed?.time === 'number') return parsed.time;
    } catch {
      return null;
    }
  }
  if (data && typeof data === 'object') {
    const time = (data as { time?: unknown }).time;
    if (typeof time === 'number') return time;
  }
  return null;
}

/**
 * Ждёт событие завершения дуэли из eventbus.
 * Если WS не настроен/недоступен — логируем и продолжаем без ожидания, чтобы не блокировать чат.
 */
export async function waitOverlayDuelCompleteEvent(
  minEventUnixSec: number
): Promise<boolean> {
  const OVERLAY_API_TOKEN = getOverlayApiToken();
  const OVERLAY_EVENTBUS_WS_URL = getOverlayEventBusWsUrl();
  const OVERLAY_DUEL_COMPLETE_WAIT_MS = getOverlayDuelCompleteWaitMs();

  console.log(`🔌 Начало ожидания DuelCompleteEvent (minEventUnixSec: ${minEventUnixSec}, таймаут: ${OVERLAY_DUEL_COMPLETE_WAIT_MS}ms)`);

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const deadline = Date.now() + OVERLAY_DUEL_COMPLETE_WAIT_MS;
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let hardTimeout: NodeJS.Timeout | null = null;
    let messagesReceived = 0;

    const finish = (ok: boolean, reason?: string): void => {
      if (settled) return;
      settled = true;
      if (hardTimeout) {
        clearTimeout(hardTimeout);
        hardTimeout = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.removeAllListeners();
        ws?.close();
      } catch {
        // ignore
      }
      if (ok) {
        console.log(`✅ DuelCompleteEvent получен (всего сообщений WS: ${messagesReceived})`);
      } else {
        console.warn(`⚠️ Overlay DuelCompleteEvent не получен: ${reason} (получено сообщений WS: ${messagesReceived})`);
      }
      resolve(ok);
    };

    // Жёсткий таймаут: если соединение держится открытым, но нужное событие не пришло —
    // всё равно завершаем ожидание, чтобы чат не "зависал" без финального сообщения.
    hardTimeout = setTimeout(() => {
      finish(false, `таймаут ${OVERLAY_DUEL_COMPLETE_WAIT_MS}ms`);
    }, OVERLAY_DUEL_COMPLETE_WAIT_MS);

    const scheduleReconnect = (): void => {
      if (settled) return;
      const left = deadline - Date.now();
      if (left <= 0) {
        finish(
          false,
          `таймаут ${OVERLAY_DUEL_COMPLETE_WAIT_MS}ms`
        );
        return;
      }
      const waitMs = Math.min(OVERLAY_EVENTBUS_RECONNECT_MS, left);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, waitMs);
    };

    const resolveEventBusUrl = (): string | null => {
      // Используем ТОЛЬКО явно заданный WS URL (Pusher /app/<key>...)
      // Никаких автодогадок вида /eventbus, чтобы не ломать существующий оверлей.
      return OVERLAY_EVENTBUS_WS_URL || null;
    };

    const connect = (): void => {
      const eventbusUrl = resolveEventBusUrl();
      if (!eventbusUrl) {
        finish(false, 'не задан OVERLAY_EVENTBUS_WS_URL');
        return;
      }

      const pusherMode = isPusherStyleUrl(eventbusUrl);
      console.log(`🔌 Подключение к WebSocket: ${eventbusUrl} (Pusher: ${pusherMode})`);

      try {
        ws = new WebSocket(
          eventbusUrl,
          pusherMode
            ? undefined
            : {
                headers: OVERLAY_API_TOKEN
                  ? { Authorization: `Bearer ${OVERLAY_API_TOKEN}` }
                  : undefined,
              }
        );
      } catch (error) {
        console.error('⚠️ Ошибка создания WS eventbus:', error);
        scheduleReconnect();
        return;
      }

      ws.on('open', () => {
        console.log(`✅ WebSocket подключен, Pusher режим: ${pusherMode}`);
        if (pusherMode) {
          const subscribePayload = {
            event: 'pusher:subscribe',
            data: {
              channel: 'eventbus',
            },
          };
          console.log(`📤 Отправка подписки на канал 'eventbus'`);
          ws?.send(JSON.stringify(subscribePayload));
        }
      });

      ws.on('message', (msg) => {
        messagesReceived++;
        const raw = typeof msg === 'string' ? msg : msg.toString('utf8');
        const payload = parseOverlayEvent(raw);
        
        if (!payload) {
          console.log(`📨 Сообщение #${messagesReceived}: не удалось распарсить`);
          return;
        }

        // Pusher service events
        if (payload.event === 'pusher:connection_established') {
          console.log(`📨 Сообщение #${messagesReceived}: pusher:connection_established`);
          return;
        }
        if (payload.event === 'pusher_internal:subscription_succeeded') {
          console.log(`📨 Сообщение #${messagesReceived}: подписка на канал успешна`);
          return;
        }
        if (payload.event === 'pusher:ping') {
          console.log(`📨 Сообщение #${messagesReceived}: ping -> отвечаем pong`);
          ws?.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          return;
        }

        console.log(`📨 Сообщение #${messagesReceived}:`, {
          event: payload.event,
          channel: payload.channel,
          dataPreview: typeof payload.data === 'string' ? payload.data.slice(0, 100) : JSON.stringify(payload.data).slice(0, 100)
        });

        if (payload.channel !== 'eventbus') {
          console.log(`   ❌ Пропущено: неправильный канал (ожидается 'eventbus', получен '${payload.channel}')`);
          return;
        }
        
        if (payload.event !== OVERLAY_DUEL_COMPLETE_EVENT) {
          console.log(`   ❌ Пропущено: неправильное событие (ожидается '${OVERLAY_DUEL_COMPLETE_EVENT}', получено '${payload.event}')`);
          return;
        }

        const eventSec = extractEventTimeSec(payload);
        console.log(`   🎯 Событие DuelCompleteEvent! time=${eventSec}, minTime=${minEventUnixSec}`);
        
        if (eventSec !== null && eventSec < minEventUnixSec) {
          console.log(`   ❌ Пропущено: событие слишком старое (${eventSec} < ${minEventUnixSec})`);
          return;
        }

        console.log(`   ✅ Событие принято!`);
        finish(true);
      });

      ws.on('error', (error) => {
        console.error('⚠️ Ошибка WS ожидания DuelCompleteEvent:', error);
        const message = error instanceof Error ? error.message : String(error || '');
        const isPermanentHttpError =
          message.includes('Unexpected server response: 404') ||
          message.includes('Unexpected server response: 403') ||
          message.includes('Unexpected server response: 401');

        if (isPermanentHttpError) {
          finish(
            false,
            `eventbus endpoint/auth rejected (${message}). Проверь OVERLAY_EVENTBUS_WS_URL и доступ.`
          );
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`🔌 WebSocket закрыт (код: ${code}, причина: ${reason || 'не указана'}), попытка переподключения...`);
        try {
          ws?.removeAllListeners();
          ws = null;
        } catch {
          // ignore
        }
        scheduleReconnect();
      });
    };

    connect();
  });
}

export async function fetchOverlayCharacters(): Promise<string[]> {
  try {
    const data = await callOverlay<any>('/game/characters', {
      method: 'GET',
    });

    if (!Array.isArray(data)) {
      return [];
    }

    // Пытаемся аккуратно вытащить имена из разных возможных форматов
    if (data.length > 0 && typeof data[0] === 'string') {
      return data as string[];
    }

    if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
      const first = data[0] as any;
      if (typeof first.name === 'string') {
        return (data as any[]).map((c) => String(c.name));
      }
      if (typeof first.title === 'string') {
        return (data as any[]).map((c) => String(c.title));
      }
      if (typeof first.slug === 'string') {
        return (data as any[]).map((c) => String(c.slug));
      }
    }

    return [];
  } catch (error: any) {
    console.error(
      '⚠️ Ошибка получения списка скинов Overlay:',
      error?.message || error
    );
    return [];
  }
}

export async function setOverlayPlayerCharacter(
  nickname: string,
  character: string
): Promise<void> {
  if (!nickname || !character) return;

  try {
    await callOverlay('/game/players/set-character', {
      method: 'POST',
      body: {
        type: 'twitch',
        nickname,
        character,
      },
    });
  } catch (error: any) {
    console.error(
      '⚠️ Ошибка вызова Overlay /game/players/set-character:',
      error?.message || error
    );
  }
}

export async function amnestyOverlayPlayer(
  nickname: string
): Promise<void> {
  if (!nickname) return;

  try {
    await callOverlay('/game/players/amnesty', {
      method: 'POST',
      body: {
        type: 'twitch',
        nickname,
      },
    });
  } catch (error: any) {
    console.error(
      '⚠️ Ошибка вызова Overlay /game/players/amnesty:',
      error?.message || error
    );
  }
}

export async function jumpOverlayPlayer(
  nickname: string
): Promise<void> {
  if (!nickname) return;

  try {
    await callOverlay('/game/players/jump', {
      method: 'POST',
      body: {
        type: 'twitch',
        nickname,
      },
    });
  } catch (error: any) {
    console.error(
      '⚠️ Ошибка вызова Overlay /game/players/jump:',
      error?.message || error
    );
  }
}

