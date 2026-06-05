const JOURNAL_TZ = 'Europe/Moscow';

export type JournalListQuery = {
  days?: string;
  date?: string;
  type?: string;
  search?: string;
};

export type JournalSqlParts = {
  whereClause: string;
  params: (string | number)[];
  nextParamIndex: number;
};

/** Период, календарный день (МСК) или всё время (без фильтра по дате). */
export function buildJournalDateWhere(query: JournalListQuery): JournalSqlParts {
  const params: (string | number)[] = [];
  const conditions: string[] = [];
  let paramIndex = 1;

  const dateStr = typeof query.date === 'string' ? query.date.trim() : '';
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);

  if (dateOk) {
    conditions.push(`(created_at AT TIME ZONE '${JOURNAL_TZ}')::date = $${paramIndex++}::date`);
    params.push(dateStr);
  } else {
    const daysRaw = query.days;
    const allTime =
      daysRaw === 'all' ||
      daysRaw === '0' ||
      (daysRaw !== undefined && daysRaw !== '' && parseInt(String(daysRaw), 10) === 0);
    if (!allTime) {
      const days = Math.min(365, Math.max(1, parseInt(String(daysRaw), 10) || 7));
      conditions.push(`created_at >= NOW() - ($${paramIndex++}::int * INTERVAL '1 day')`);
      params.push(days);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params, nextParamIndex: paramIndex };
}

export function appendJournalTypeFilter(
  parts: JournalSqlParts,
  eventType: string | null,
): JournalSqlParts {
  if (!eventType) return parts;
  const clause = parts.whereClause ? ' AND ' : ' WHERE ';
  const cond = `event_type = $${parts.nextParamIndex}`;
  return {
    whereClause: `${parts.whereClause}${clause}${cond}`,
    params: [...parts.params, eventType],
    nextParamIndex: parts.nextParamIndex + 1,
  };
}

export function appendJournalSearchFilter(
  parts: JournalSqlParts,
  search: string,
): JournalSqlParts {
  const q = search.trim().toLowerCase();
  if (!q) return parts;
  const clause = parts.whereClause ? ' AND ' : ' WHERE ';
  const cond = `(LOWER(username) LIKE $${parts.nextParamIndex} OR LOWER(message) LIKE $${parts.nextParamIndex})`;
  return {
    whereClause: `${parts.whereClause}${clause}${cond}`,
    params: [...parts.params, `%${q}%`],
    nextParamIndex: parts.nextParamIndex + 1,
  };
}
