export function formatName(name: string, maxLength: number = 20): string {
  if (name.length <= maxLength) {
    return name;
  }

  return name.substring(0, maxLength - 3) + '...';
}

/** Ник для ответа в чат: имя без @, чтобы Telegram не создавал упоминание. */
export function displayName(firstName?: string | null, fallback = 'Пользователь'): string {
  const trimmed = firstName?.trim();
  return formatName(trimmed || fallback);
}