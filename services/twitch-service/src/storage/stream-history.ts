import { query, getPool } from '../database/database';

export interface StreamHistoryEntry {
  date: string;
  startTime: string;
  duration: string;
  peakViewers: number;
  followsCount?: number;
}

export async function loadStreamHistory(): Promise<StreamHistoryEntry[]> {
  const rows = await query<{
    stream_date: string;
    start_time: string;
    duration: string;
    peak_viewers: number;
    follows_count: number | null;
  }>(`
    SELECT stream_date, start_time, duration, peak_viewers, follows_count
    FROM stream_history
    ORDER BY stream_date DESC, start_time DESC
  `);

  return rows.map(row => ({
    date: row.stream_date,
    startTime: row.start_time,
    duration: row.duration,
    peakViewers: row.peak_viewers,
    followsCount: row.follows_count || undefined
  }));
}

export function saveStreamHistory(_history: StreamHistoryEntry[]): void {
  console.warn('[STREAM-HISTORY] saveStreamHistory устарела, используйте addStreamToHistory');
}

export async function addStreamToHistory(entry: StreamHistoryEntry): Promise<void> {
  await query(
    `INSERT INTO stream_history (stream_date, start_time, duration, peak_viewers, follows_count)
    VALUES ($1, $2, $3, $4, $5)`,
    [entry.date, entry.startTime, entry.duration, entry.peakViewers, entry.followsCount || null]
  );
  console.log(`✅ Стрим добавлен в историю: ${entry.date} ${entry.startTime}`);
}

export async function getStreamStats(startDate?: string, endDate?: string): Promise<{
  totalStreams: number;
  totalDuration: string;
  avgPeakViewers: number;
  totalFollows: number;
}> {
  let queryText = `
    SELECT 
      COUNT(*)::int as total_streams,
      AVG(peak_viewers)::float as avg_peak_viewers,
      COALESCE(SUM(follows_count), 0)::int as total_follows
    FROM stream_history
  `;
  const params: (string | number)[] = [];

  if (startDate && endDate) {
    queryText += ' WHERE stream_date BETWEEN $1 AND $2';
    params.push(startDate, endDate);
  }

  const rows = await query<{
    total_streams: number;
    avg_peak_viewers: number | null;
    total_follows: number;
  }>(queryText, params.length ? params : undefined);
  const result = rows[0];

  const durationQuery = startDate && endDate
    ? 'SELECT duration FROM stream_history WHERE stream_date BETWEEN $1 AND $2'
    : 'SELECT duration FROM stream_history';
  const durationParams = startDate && endDate ? [startDate, endDate] : undefined;
  const durationRows = await query<{ duration: string }>(durationQuery, durationParams);
  let totalSeconds = 0;
  durationRows.forEach(row => {
    const parts = row.duration.split(':');
    if (parts.length === 3) {
      totalSeconds += parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
    }
  });

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const totalDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

  return {
    totalStreams: result?.total_streams ?? 0,
    totalDuration,
    avgPeakViewers: result?.avg_peak_viewers ? Math.round(result.avg_peak_viewers) : 0,
    totalFollows: result?.total_follows ?? 0
  };
}

export async function cleanupOldStreams(daysOld: number): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

  const result = await getPool().query('DELETE FROM stream_history WHERE stream_date < $1', [cutoffDateStr]);
  const deleted = result.rowCount ?? 0;

  if (deleted > 0) {
    console.log(`🗑️ Удалено ${deleted} старых записей из истории стримов`);
  }

  return deleted;
}
