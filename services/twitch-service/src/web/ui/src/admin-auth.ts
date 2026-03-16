const STORAGE_KEY = 'adminAuth';

export function getAdminPassword(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAdminPassword(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}

export function clearAdminAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function getAdminHeaders(): Record<string, string> {
  const pwd = getAdminPassword();
  if (!pwd) return {};
  return { Authorization: `Bearer ${pwd}` };
}
