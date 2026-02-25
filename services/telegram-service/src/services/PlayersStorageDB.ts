import { query, queryOne } from '../database/database';

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

function rowToPlayer(row: PlayerStatsRow): Player {
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

export class PlayersStorageDB {
  async get(userId: number): Promise<Player | undefined> {
    const row = await queryOne<PlayerStatsRow>(
      'SELECT * FROM player_stats WHERE telegram_id = $1',
      [userId]
    );
    if (!row) return undefined;
    return rowToPlayer(row);
  }

  async set(userId: number, player: Player): Promise<void> {
    const existing = await queryOne(
      'SELECT telegram_id FROM player_stats WHERE telegram_id = $1',
      [userId]
    );

    if (!existing) {
      await query(
        `INSERT INTO player_stats (telegram_id, username, first_name, size, last_used, last_used_date,
          last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          userId, player.username, player.firstName, player.size, player.lastUsed, player.lastUsedDate,
          player.lastHornyDate || null, player.lastFurryDate || null, player.lastFutureDate || null,
          player.futureAttemptsToday || 0, player.lastGrowth || 0
        ]
      );
    } else {
      await query(
        `UPDATE player_stats SET username=$1, first_name=$2, size=$3, last_used=$4, last_used_date=$5,
          last_horny_date=$6, last_furry_date=$7, last_future_date=$8, future_attempts_today=$9, last_growth=$10,
          updated_at=CURRENT_TIMESTAMP WHERE telegram_id=$11`,
        [
          player.username, player.firstName, player.size, player.lastUsed, player.lastUsedDate,
          player.lastHornyDate || null, player.lastFurryDate || null, player.lastFutureDate || null,
          player.futureAttemptsToday || 0, player.lastGrowth || 0, userId
        ]
      );
    }
  }

  async getRank(userId: number): Promise<number> {
    const row = await queryOne<{ size: number }>(
      'SELECT size FROM player_stats WHERE telegram_id = $1',
      [userId]
    );
    if (!row) return 0;
    const countResult = await queryOne<{ count: number }>(
      'SELECT COUNT(*)::int as count FROM player_stats WHERE size > $1',
      [row.size]
    );
    const count = countResult?.count ?? 0;
    return (typeof count === 'string' ? parseInt(count, 10) : count) + 1;
  }

  async getTop(limit: number = 10): Promise<Player[]> {
    const rows = await query<PlayerStatsRow>(
      `SELECT telegram_id, username, first_name, size, last_used, last_used_date,
        last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth
      FROM player_stats ORDER BY size DESC LIMIT $1`,
      [limit]
    );
    return rows.map(rowToPlayer);
  }

  async getBottom(limit: number = 10): Promise<Player[]> {
    const rows = await query<PlayerStatsRow>(
      `SELECT telegram_id, username, first_name, size, last_used, last_used_date,
        last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth
      FROM player_stats ORDER BY size ASC LIMIT $1`,
      [limit]
    );
    return rows.map(rowToPlayer);
  }

  async getAll(): Promise<Map<number, Player>> {
    const rows = await query<PlayerStatsRow>(
      `SELECT telegram_id, username, first_name, size, last_used, last_used_date,
        last_horny_date, last_furry_date, last_future_date, future_attempts_today, last_growth
      FROM player_stats`
    );
    const map = new Map<number, Player>();
    rows.forEach(r => map.set(r.telegram_id, rowToPlayer(r)));
    return map;
  }
}
