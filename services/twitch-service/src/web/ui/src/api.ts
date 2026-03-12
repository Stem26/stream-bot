import type { CommandsData, CustomCommand, LinksConfig } from './types';

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

export async function fetchLinksConfig(): Promise<LinksConfig> {
  const response = await fetch('/api/links');
  return handleJson<LinksConfig>(response, 'Ошибка загрузки ссылок');
}

export async function updateLinksConfig(allLinksText: string): Promise<LinksConfig> {
  const response = await fetch('/api/links', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allLinksText }),
  });
  return handleJson<LinksConfig>(response, 'Ошибка сохранения ссылок');
}

