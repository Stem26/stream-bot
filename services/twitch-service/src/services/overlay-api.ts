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

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const deadline = Date.now() + OVERLAY_DUEL_COMPLETE_WAIT_MS;
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;

    const finish = (ok: boolean, reason?: string): void => {
      if (settled) return;
      settled = true;
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
      if (!ok && reason) {
        console.warn(`⚠️ Overlay DuelCompleteEvent не получен: ${reason}`);
      }
      resolve(ok);
    };

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
        if (pusherMode) {
          const subscribePayload = {
            event: 'pusher:subscribe',
            data: {
              channel: 'eventbus',
            },
          };
          ws?.send(JSON.stringify(subscribePayload));
        }
      });

      ws.on('message', (msg) => {
        const raw = typeof msg === 'string' ? msg : msg.toString('utf8');
        const payload = parseOverlayEvent(raw);
        if (!payload) return;

        // Pusher service events
        if (payload.event === 'pusher:connection_established') return;
        if (payload.event === 'pusher_internal:subscription_succeeded') return;
        if (payload.event === 'pusher:ping') {
          ws?.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          return;
        }

        if (payload.channel !== 'eventbus') return;
        if (payload.event !== OVERLAY_DUEL_COMPLETE_EVENT) return;

        const eventSec = extractEventTimeSec(payload);
        if (eventSec !== null && eventSec < minEventUnixSec) return;

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

      ws.on('close', () => {
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

