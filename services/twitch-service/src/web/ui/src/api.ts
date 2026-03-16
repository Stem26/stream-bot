import type {
  CommandsData,
  CustomCommand,
  LinksConfig,
  CountersData,
  Counter,
  PartyItemsData,
  PartyItem,
  PartyConfig,
  ChatModerationConfig,
} from './types';

async function handleJson<T>(response: Response, defaultError: string): Promise<T> {
  if (!response.ok) {
    let message = defaultError;
    try {
      const error = await response.json();
      if (error && typeof error.error === 'string') {
        message = error.error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function fetchCommands(): Promise<CommandsData> {
  const response = await fetch('/api/commands');
  return handleJson<CommandsData>(response, 'Ошибка загрузки команд');
}

export async function createCommand(command: CustomCommand): Promise<CustomCommand> {
  const response = await fetch('/api/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  return handleJson<CustomCommand>(response, 'Ошибка создания команды');
}

export async function updateCommand(id: string, command: CustomCommand): Promise<CustomCommand> {
  const response = await fetch(`/api/commands/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  return handleJson<CustomCommand>(response, 'Ошибка обновления команды');
}

export async function deleteCommand(id: string): Promise<void> {
  const response = await fetch(`/api/commands/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await handleJson<unknown>(response, 'Ошибка удаления команды');
}

export async function toggleCommand(id: string): Promise<CustomCommand> {
  const response = await fetch(`/api/commands/${encodeURIComponent(id)}/toggle`, {
    method: 'PATCH',
  });
  return handleJson<CustomCommand>(response, 'Ошибка переключения команды');
}

export async function toggleCommandRotation(id: string): Promise<CustomCommand> {
  const response = await fetch(`/api/commands/${encodeURIComponent(id)}/rotation-toggle`, {
    method: 'PATCH',
  });
  return handleJson<CustomCommand>(response, 'Ошибка переключения ротации команды');
}

export async function fetchLinksConfig(): Promise<LinksConfig> {
  const response = await fetch('/api/links');
  return handleJson<LinksConfig>(response, 'Ошибка загрузки ссылок');
}

export async function updateLinksConfig(config: { allLinksText: string; rotationIntervalMinutes?: number }): Promise<LinksConfig> {
  const response = await fetch('/api/links', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      config.rotationIntervalMinutes != null
        ? {
            allLinksText: config.allLinksText,
            rotationIntervalMinutes: config.rotationIntervalMinutes,
          }
        : {
            allLinksText: config.allLinksText,
          },
    ),
  });
  return handleJson<LinksConfig>(response, 'Ошибка сохранения ссылок');
}

// === API для счётчиков ===

export async function fetchCounters(): Promise<CountersData> {
  const response = await fetch('/api/counters');
  return handleJson<CountersData>(response, 'Ошибка загрузки счётчиков');
}

export async function createCounter(counter: Counter): Promise<Counter> {
  const response = await fetch('/api/counters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(counter),
  });
  return handleJson<Counter>(response, 'Ошибка создания счётчика');
}

export async function updateCounter(id: string, counter: Counter): Promise<Counter> {
  const response = await fetch(`/api/counters/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(counter),
  });
  return handleJson<Counter>(response, 'Ошибка обновления счётчика');
}

export async function deleteCounter(id: string): Promise<void> {
  const response = await fetch(`/api/counters/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await handleJson<unknown>(response, 'Ошибка удаления счётчика');
}

export async function toggleCounter(id: string): Promise<Counter> {
  const response = await fetch(`/api/counters/${encodeURIComponent(id)}/toggle`, {
    method: 'PATCH',
  });
  return handleJson<Counter>(response, 'Ошибка переключения счётчика');
}

export async function incrementCounter(id: string): Promise<Counter> {
  const response = await fetch(`/api/counters/${encodeURIComponent(id)}/increment`, {
    method: 'PATCH',
  });
  return handleJson<Counter>(response, 'Ошибка инкремента счётчика');
}

// === API для партии ===

export async function fetchPartyItems(): Promise<PartyItemsData> {
  const response = await fetch('/api/party/items');
  return handleJson<PartyItemsData>(response, 'Ошибка загрузки партии');
}

export async function fetchPartyConfig(): Promise<PartyConfig> {
  const response = await fetch('/api/party/config');
  return handleJson<PartyConfig>(response, 'Ошибка загрузки настроек');
}

export async function updatePartyConfig(config: PartyConfig): Promise<PartyConfig> {
  const response = await fetch('/api/party/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return handleJson<PartyConfig>(response, 'Ошибка сохранения');
}

export async function setPartySkipCooldown(skipCooldown: boolean): Promise<{ skipCooldown: boolean }> {
  const response = await fetch('/api/party/config/skip-cooldown', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skipCooldown }),
  });
  return handleJson<{ skipCooldown: boolean }>(response, 'Ошибка');
}

export async function createPartyItem(text: string): Promise<PartyItem> {
  const response = await fetch('/api/party/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return handleJson<PartyItem>(response, 'Ошибка добавления');
}

export async function updatePartyItem(id: number, text: string): Promise<PartyItem> {
  const response = await fetch(`/api/party/items/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return handleJson<PartyItem>(response, 'Ошибка обновления');
}

export async function deletePartyItem(id: number): Promise<void> {
  const response = await fetch(`/api/party/items/${id}`, {
    method: 'DELETE',
  });
  await handleJson<unknown>(response, 'Ошибка удаления');
}

// === API для модерации чата ===

export async function fetchChatModerationConfig(): Promise<ChatModerationConfig> {
  const response = await fetch('/api/admin/chat-moderation/config');
  return handleJson<ChatModerationConfig>(response, 'Ошибка загрузки настроек модерации');
}

export async function updateChatModerationConfig(
  config: ChatModerationConfig,
): Promise<ChatModerationConfig> {
  const response = await fetch('/api/admin/chat-moderation/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return handleJson<ChatModerationConfig>(response, 'Ошибка сохранения настроек модерации');
}

// === API для whitelist ссылок ===

export async function fetchLinkWhitelist(): Promise<{ patterns: string[] }> {
  const response = await fetch('/api/admin/link-whitelist');
  return handleJson<{ patterns: string[] }>(response, 'Ошибка загрузки whitelist ссылок');
}

export async function updateLinkWhitelist(patterns: string[]): Promise<{ patterns: string[] }> {
  const response = await fetch('/api/admin/link-whitelist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patterns }),
  });
  return handleJson<{ patterns: string[] }>(response, 'Ошибка сохранения whitelist ссылок');
}

