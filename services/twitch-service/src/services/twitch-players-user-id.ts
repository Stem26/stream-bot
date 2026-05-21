/** Нормализация Twitch user id из чата / Helix (только цифры). */
export function normalizeTwitchUserId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const id = String(raw).trim();
  return /^\d+$/.test(id) ? id : null;
}
