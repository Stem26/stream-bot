const OVERLAY_API_BASE_URL = process.env.OVERLAY_API_BASE_URL;
const OVERLAY_API_TOKEN = process.env.OVERLAY_API_TOKEN;

type OverlayRequest = {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
};

async function callOverlay<T = unknown>(
  path: string,
  init: OverlayRequest = {}
): Promise<T> {
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

  const response = await fetch(
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
  nickname: string
): Promise<void> {
  if (!nickname) return;

  try {
    await callOverlay('/game/trigger', {
      method: 'POST',
      body: {
        type: 'twitch',
        nickname,
      },
    });
  } catch (error: any) {
    console.error(
      '⚠️ Ошибка вызова Overlay /game/trigger:',
      error?.message || error
    );
  }
}

export type DuelMode = 'a-win' | 'b-win' | 'all-win' | 'all-lose';

export async function sendOverlayDuel(
  playerA: string,
  playerB: string,
  mode: DuelMode
): Promise<void> {
  if (!playerA || !playerB) return;

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
  } catch (error: any) {
    console.error(
      '⚠️ Ошибка вызова Overlay /game/duel:',
      error?.message || error
    );
  }
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
      '⚠️ Ошибка получения списка персонажей Overlay:',
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

