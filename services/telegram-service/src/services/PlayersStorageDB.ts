import { getDatabase } from '../database/database';

export interface Player {
  userId: number;
  username: string;
  firstName: string;
  size: number;
  lastUsed: number;
  lastUsedDate: string;
  lastHornyDate?: string;
  lastFurryDate?: string;
  lastFutureDate?: string;
  futureAttemptsToday?: number;
  lastGrowth?: number;
}

interface PlayerStatsRow {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  size: number;
  last_used: number | null;
  last_used_date: string | null;
  last_horny_date: string | null;
  last_furry_date: string | null;
  last_future_date: string | null;
  future_attempts_today: number | null;
  last_growth: number | null;
}

export class PlayersStorageDB {
  get(userId: number): Player | undefined {
    const row = getDatabase().prepare('SELECT * FROM player_stats WHERE telegram_id = ?').get(userId) as PlayerStatsRow | undefined;
    if (!row) return undefined;
    return {
      userId: row.telegram_id,
      username: row.username || '',
      firstName: row.first_name || '',
      size: row.size,
      lastUsed: row.last_used || 0,
      lastUsedDate: row.last_used_date || '',
      lastHornyDate: row.last_horny_date || undefined,
      lastFurryDate: row.last_furry_date || undefined,
      lastFutureDate: row.last_future_date || undefined,
      futureAttemptsToday: row.future_attempts_today || 0,
      lastGrowth: row.last_growth || 0
    };
  }

  set(userId: number, player: Player): void {
    const db = getDatabase();
    const row = db.prepare('SELECT telegram_id FROM player_stats WHERE telegram_id = ?').get(userId);
    if (!row) {
      db.prepare(`
        INSERT INTO player_stats (telegram_id, username, first_name, size, last_used, last_used_date,
          last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId, player.username, player.firstName, player.size, player.lastUsed, player.lastUsedDate,
        player.lastHornyDate || null, player.lastFurryDate || null, player.lastFutureDate || null,
        player.futureAttemptsToday || 0, player.lastGrowth || 0
      );
    } else {
      db.prepare(`
        UPDATE player_stats SET username=?, first_name=?, size=?, last_used=?, last_used_date=?,
          last_horny_date=?, last_furry_date=?, last_future_date=?, future_attempts_today=?, last_growth=?,
          updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?
      `).run(
        player.username, player.firstName, player.size, player.lastUsed, player.lastUsedDate,
        player.lastHornyDate || null, player.lastFurryDate || null, player.lastFutureDate || null,
        player.futureAttemptsToday || 0, player.lastGrowth || 0, userId
      );
    }
  }

  getRank(userId: number): number {
    const row = getDatabase().prepare('SELECT size FROM player_stats WHERE telegram_id = ?').get(userId) as { size: number } | undefined;
    if (!row) return 0;
    const count = getDatabase().prepare('SELECT COUNT(*) as count FROM player_stats WHERE size > ?').get(row.size) as { count: number };
    return count.count + 1;
  }

  getTop(limit: number = 10): Player[] {
    const rows = getDatabase().prepare(`
      SELECT telegram_id, username, first_name, size, last_used, last_used_date,
        last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth
      FROM player_stats ORDER BY size DESC LIMIT ?
    `).all(limit) as PlayerStatsRow[];
    return rows.map(r => ({
      userId: r.telegram_id,
      username: r.username || '',
      firstName: r.first_name || '',
      size: r.size,
      lastUsed: r.last_used || 0,
      lastUsedDate: r.last_used_date || '',
      lastHornyDate: r.last_horny_date || undefined,
      lastFurryDate: r.last_furry_date || undefined,
      lastFutureDate: r.last_future_date || undefined,
      futureAttemptsToday: r.future_attempts_today || 0,
      lastGrowth: r.last_growth || 0
    }));
  }

  getBottom(limit: number = 10): Player[] {
    const rows = getDatabase().prepare(`
      SELECT telegram_id, username, first_name, size, last_used, last_used_date,
        last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth
      FROM player_stats ORDER BY size ASC LIMIT ?
    `).all(limit) as PlayerStatsRow[];
    return rows.map(r => ({
      userId: r.telegram_id,
      username: r.username || '',
      firstName: r.first_name || '',
      size: r.size,
      lastUsed: r.last_used || 0,
      lastUsedDate: r.last_used_date || '',
      lastHornyDate: r.last_horny_date || undefined,
      lastFurryDate: r.last_furry_date || undefined,
      lastFutureDate: r.last_future_date || undefined,
      futureAttemptsToday: r.future_attempts_today || 0,
      lastGrowth: r.last_growth || 0
    }));
  }

  getAll(): Map<number, Player> {
    const rows = getDatabase().prepare(`
      SELECT telegram_id, username, first_name, size, last_used, last_used_date,
        last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth
      FROM player_stats
    `).all() as PlayerStatsRow[];
    const map = new Map<number, Player>();
    rows.forEach(r => map.set(r.telegram_id, {
      userId: r.telegram_id,
      username: r.username || '',
      firstName: r.first_name || '',
      size: r.size,
      lastUsed: r.last_used || 0,
      lastUsedDate: r.last_used_date || '',
      lastHornyDate: r.last_horny_date || undefined,
      lastFurryDate: r.last_furry_date || undefined,
      lastFutureDate: r.last_future_date || undefined,
      futureAttemptsToday: r.future_attempts_today || 0,
      lastGrowth: r.last_growth || 0
    }));
    return map;
  }
}
