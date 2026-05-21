/** Донатер не участвует в топах дня / месяца (анонимные и пустые). */
export function isDonateXExcludedFromTop(username: string | null | undefined): boolean {
  if (!username?.trim()) return true;
  const n = username.trim().toLowerCase();
  if (n === 'аноним' || n === 'anonymous' || n === 'anon') return true;
  if (n.startsWith('аноним')) return true;
  return false;
}

/** SQL-фрагмент: username не аноним (параметр — имя колонки, напр. d.username). */
export function donatexTopUsernameSql(column: string): string {
  const c = column.trim();
  return `LOWER(TRIM(${c})) NOT IN ('аноним', 'anonymous', 'anon')
    AND LOWER(TRIM(${c})) NOT LIKE 'аноним%'`;
}
