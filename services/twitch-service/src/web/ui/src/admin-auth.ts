const STORAGE_KEY = 'adminAuth';

/** Возвращает JWT-токен (ранее — пароль) для Bearer-авторизации */
export function getAdminPassword(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Сохраняет JWT-токен после успешного входа */
export function setAdminPassword(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearAdminAuth(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function getAdminHeaders(): Record<string, string> {
  const pwd = getAdminPassword();
  if (!pwd) return {};
  return { Authorization: `Bearer ${pwd}` };
}
