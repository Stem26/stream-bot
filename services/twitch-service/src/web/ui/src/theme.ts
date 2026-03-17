const STORAGE_KEY = 'app-theme';
export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* ignore */ }
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme } }));
}

export function initTheme(): Theme {
  const theme = getTheme();
  document.documentElement.classList.remove('theme-dark-pending');
  document.body.classList.toggle('theme-dark', theme === 'dark');
  return theme;
}
