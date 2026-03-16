export function substituteTimePlaceholders(text: string): string {
  const now = new Date();
  const fmt = (tz: string) => {
    try {
      return new Intl.DateTimeFormat('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: tz,
      }).format(now);
    } catch {
      return `?(${tz})`;
    }
  };
  return text.replace(/\{time:([^}]+)\}/g, (_, tz) => fmt(tz.trim()));
}
