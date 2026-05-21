import { getPool } from '../../database/database';

export interface DonateXStreamWindow {
  streamDate: string;
  streamStart: string;
  streamEnd: string;
}

/** Окна стримов за календарный месяц (stream_history). */
export async function loadDonateXStreamWindowsForMonth(
  year: number,
  month: number,
  timezone: string
): Promise<DonateXStreamWindow[]> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      stream_date: string;
      stream_start: Date;
      stream_end: Date;
    }>(
      `SELECT
        sh.stream_date,
        make_timestamptz(
          sh.stream_date::date,
          make_time(
            (regexp_match(sh.start_time, '(\\d{1,2}):(\\d{2})'))[1]::int,
            (regexp_match(sh.start_time, '(\\d{1,2}):(\\d{2})'))[2]::int,
            0
          ),
          $1::text
        ) AS stream_start,
        make_timestamptz(
          sh.stream_date::date,
          make_time(
            (regexp_match(sh.start_time, '(\\d{1,2}):(\\d{2})'))[1]::int,
            (regexp_match(sh.start_time, '(\\d{1,2}):(\\d{2})'))[2]::int,
            0
          ),
          $1::text
        ) + (
          COALESCE(NULLIF(split_part(sh.duration, ':', 1), ''), '0')::int * interval '1 hour' +
          COALESCE(NULLIF(split_part(sh.duration, ':', 2), ''), '0')::int * interval '1 minute' +
          COALESCE(NULLIF(split_part(sh.duration, ':', 3), ''), '0')::int * interval '1 second'
        ) AS stream_end
      FROM stream_history sh
      WHERE sh.stream_date::date >= make_date($2::int, $3::int, 1)
        AND sh.stream_date::date < (make_date($2::int, $3::int, 1) + INTERVAL '1 month')
      ORDER BY sh.stream_date DESC, stream_start DESC`,
      [timezone, year, month]
    );

    return rows.map((r) => ({
      streamDate: r.stream_date,
      streamStart: r.stream_start.toISOString(),
      streamEnd: r.stream_end.toISOString(),
    }));
  } catch (err) {
    console.warn('[DONATEX] stream_history недоступна — топ по календарным дням:', err);
    return [];
  }
}

export function findStreamWindowForDate(
  windows: DonateXStreamWindow[],
  date: string
): DonateXStreamWindow | undefined {
  return windows.find((w) => w.streamDate === date || w.streamDate.startsWith(date));
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
