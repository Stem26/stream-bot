import { getPool } from '../../database/database';

export interface DonateXStreamWindow {
  streamDate: string;
  streamStart: string;
  streamEnd: string;
}

/** Пауза между концом и началом — всё ещё один стрим (reconnect). */
const STREAM_MERGE_GAP_MS =
  (parseInt(process.env.DONATEX_STREAM_MERGE_GAP_HOURS ?? '4', 10) || 4) * 60 * 60 * 1000;

/** Запас к концу окна (рассинхрон часов / поздние донаты). */
const STREAM_END_GRACE_MS =
  (parseInt(process.env.DONATEX_STREAM_END_GRACE_MIN ?? '30', 10) || 30) * 60 * 1000;

/** Длительность из stream_history: «6ч 53мин» или «7:54:00». */
export function parseStreamDurationMs(duration: string): number {
  const trimmed = duration.trim();
  const hMatch = trimmed.match(/(\d+)\s*ч/);
  const mMatch = trimmed.match(/(\d+)\s*мин/);
  if (hMatch || mMatch) {
    const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
    const mins = mMatch ? parseInt(mMatch[1], 10) : 0;
    return (hours * 3600 + mins * 60) * 1000;
  }
  const parts = trimmed.split(':').map((p) => parseInt(p, 10) || 0);
  if (parts.length >= 2) {
    const [hh, mm, ss = 0] = parts;
    return (hh * 3600 + mm * 60 + ss) * 1000;
  }
  return 0;
}

/** Старт стрима в UTC из календарной даты и «18:34 МСК» (MSK = UTC+3). */
function parseStreamStartUtc(streamDate: string, startTime: string): Date | null {
  const tm = startTime.match(/(\d{1,2}):(\d{2})/);
  if (!tm) return null;
  const parts = streamDate.split('-').map((x) => parseInt(x, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, mo, d] = parts;
  const hour = parseInt(tm[1], 10);
  const min = parseInt(tm[2], 10);
  return new Date(Date.UTC(y, mo - 1, d, hour - 3, min, 0));
}

export function buildStreamWindowFromHistory(row: {
  stream_date: string;
  start_time: string;
  duration: string;
}): DonateXStreamWindow | null {
  const start = parseStreamStartUtc(row.stream_date, row.start_time);
  if (!start) return null;
  const durationMs = parseStreamDurationMs(row.duration);
  if (durationMs <= 0) return null;
  const end = new Date(start.getTime() + durationMs + STREAM_END_GRACE_MS);
  return {
    streamDate: row.stream_date,
    streamStart: start.toISOString(),
    streamEnd: end.toISOString(),
  };
}

/**
 * Склеивает соседние окна из stream_history в одну сессию.
 */
export function mergeDonateXStreamSessions(windows: DonateXStreamWindow[]): DonateXStreamWindow[] {
  if (windows.length <= 1) return [...windows];

  const sorted = [...windows].sort(
    (a, b) => new Date(a.streamStart).getTime() - new Date(b.streamStart).getTime()
  );

  const merged: DonateXStreamWindow[] = [];
  let cur: DonateXStreamWindow = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const curEnd = new Date(cur.streamEnd).getTime();
    const nextStart = new Date(next.streamStart).getTime();
    const nextEnd = new Date(next.streamEnd).getTime();
    const gap = nextStart - curEnd;

    if (gap <= STREAM_MERGE_GAP_MS) {
      cur = {
        streamDate: cur.streamDate,
        streamStart: cur.streamStart,
        streamEnd: new Date(Math.max(curEnd, nextEnd)).toISOString(),
      };
    } else {
      merged.push(cur);
      cur = { ...next };
    }
  }
  merged.push(cur);

  return merged.sort(
    (a, b) => new Date(b.streamStart).getTime() - new Date(a.streamStart).getTime()
  );
}

/** Окна стримов за календарный месяц (stream_history). */
export async function loadDonateXStreamWindowsForMonth(
  year: number,
  month: number,
  _timezone: string
): Promise<DonateXStreamWindow[]> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      stream_date: string;
      start_time: string;
      duration: string;
    }>(
      `SELECT sh.stream_date, sh.start_time, sh.duration
      FROM stream_history sh
      WHERE sh.stream_date::date >= make_date($1::int, $2::int, 1)
        AND sh.stream_date::date < (make_date($1::int, $2::int, 1) + INTERVAL '1 month')
      ORDER BY sh.stream_date DESC, sh.start_time DESC`,
      [year, month]
    );

    const raw: DonateXStreamWindow[] = [];
    for (const row of rows) {
      const w = buildStreamWindowFromHistory(row);
      if (w) raw.push(w);
    }
    return mergeDonateXStreamSessions(raw);
  } catch (err) {
    console.warn('[DONATEX] stream_history недоступна — топ по календарным дням:', err);
    return [];
  }
}

export function findStreamWindowForDate(
  windows: DonateXStreamWindow[],
  date: string
): DonateXStreamWindow | undefined {
  return findStreamWindowsForDate(windows, date)[0];
}

/** Все сессии стрима, пересекающие календарную дату. */
export function findStreamWindowsForDate(
  windows: DonateXStreamWindow[],
  date: string
): DonateXStreamWindow[] {
  const dayStart = parseStreamStartUtc(date, '00:00');
  const dayEnd = parseStreamStartUtc(date, '23:59');
  if (!dayStart || !dayEnd) {
    return windows.filter((w) => w.streamDate === date || w.streamDate.startsWith(date));
  }
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime() + 59 * 60 * 1000;
  return windows.filter((w) => {
    const s = new Date(w.streamStart).getTime();
    const e = new Date(w.streamEnd).getTime();
    return s < dayEndMs && e > dayStartMs;
  });
}

export function streamWindowsToJsonb(windows: DonateXStreamWindow[]): string {
  return JSON.stringify(
    windows.map((w) => ({
      stream_date: w.streamDate,
      stream_start: w.streamStart,
      stream_end: w.streamEnd,
    }))
  );
}
