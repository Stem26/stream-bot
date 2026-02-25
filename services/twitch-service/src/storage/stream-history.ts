import { getDatabase } from '../database/database';

export interface StreamHistoryEntry {
  date: string;
  startTime: string;
  duration: string;
  peakViewers: number;
  followsCount?: number;
}

/**
 * Загружает историю стримов из БД
 */
export function loadStreamHistory(): StreamHistoryEntry[] {
  const db = getDatabase();
  
  const rows = db.prepare(`
    SELECT stream_date, start_time, duration, peak_viewers, follows_count
    FROM stream_history
    ORDER BY stream_date DESC, start_time DESC
  `).all() as Array<{
    stream_date: string;
    start_time: string;
    duration: string;
    peak_viewers: number;
    follows_count: number | null;
  }>;

  return rows.map(row => ({
    date: row.stream_date,
    startTime: row.start_time,
    duration: row.duration,
    peakViewers: row.peak_viewers,
    followsCount: row.follows_count || undefined
  }));
}

/**
 * Сохраняет историю стримов (устаревшая функция для совместимости)
 * @deprecated Используйте addStreamToHistory для добавления записей
 */
export function saveStreamHistory(_history: StreamHistoryEntry[]): void {
  console.warn('[STREAM-HISTORY] saveStreamHistory устарела, используйте addStreamToHistory');
}

/**
 * Добавляет запись о стриме в историю
 */
export function addStreamToHistory(entry: StreamHistoryEntry): void {
  const db = getDatabase();
  
  db.prepare(`
    INSERT INTO stream_history (stream_date, start_time, duration, peak_viewers, follows_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    entry.date,
    entry.startTime,
    entry.duration,
    entry.peakViewers,
    entry.followsCount || null
  );

  console.log(`✅ Стрим добавлен в историю: ${entry.date} ${entry.startTime}`);
}

/**
 * Получает статистику стримов за период
 */
export function getStreamStats(startDate?: string, endDate?: string): {
  totalStreams: number;
  totalDuration: string;
  avgPeakViewers: number;
  totalFollows: number;
} {
  const db = getDatabase();
  
  let query = `
    SELECT 
      COUNT(*) as total_streams,
      AVG(peak_viewers) as avg_peak_viewers,
      SUM(follows_count) as total_follows
    FROM stream_history
  `;
  
  const params: (string | number)[] = [];
  
  if (startDate && endDate) {
    query += ' WHERE stream_date BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }
  
  const result = db.prepare(query).get(...params) as {
    total_streams: number;
    avg_peak_viewers: number | null;
    total_follows: number | null;
  };
  
  const durationResult = db.prepare(`
    SELECT duration FROM stream_history
  `).all() as Array<{ duration: string }>;
  
  let totalSeconds = 0;
  durationResult.forEach(row => {
    const parts = row.duration.split(':');
    if (parts.length === 3) {
      totalSeconds += parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    }
  });
  
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const totalDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  
  return {
    totalStreams: result.total_streams,
    totalDuration,
    avgPeakViewers: result.avg_peak_viewers ? Math.round(result.avg_peak_viewers) : 0,
    totalFollows: result.total_follows || 0
  };
}

/**
 * Удаляет старые записи истории (опционально)
 */
export function cleanupOldStreams(daysOld: number): number {
  const db = getDatabase();
  
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);
  const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
  
  const result = db.prepare(`
    DELETE FROM stream_history
    WHERE stream_date < ?
  `).run(cutoffDateStr);
  
  if (result.changes > 0) {
    console.log(`🗑️ Удалено ${result.changes} старых записей из истории стримов`);
  }
  
  return result.changes;
}
