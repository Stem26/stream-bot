const STORAGE_KEY = 'adminAuth';

export function getAdminPassword(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAdminPassword(password: string): void {
  sessionStorage.setItem(STORAGE_KEY, password);
}

export function clearAdminAuth(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function getAdminHeaders(): Record<string, string> {
  const pwd = getAdminPassword();
  if (!pwd) return {};
  return { Authorization: `Bearer ${pwd}` };
}
