import { query, queryOne, getPool } from '../database/database';
import { normalizeTwitchUserId } from './twitch-players-user-id';

export interface TwitchPlayerData {
  twitchUsername: string;
  twitchUserId?: string;
  size: number;
  lastUsed: number;
  lastUsedDate?: string;
  points?: number;
  duelTimeoutUntil?: number;
  duelCooldownUntil?: number;
  duelWins?: number;
  duelLosses?: number;
  duelDraws?: number;
  // ежедневные дуэли
  duelsToday?: number;
  lastDuelDate?: string;
  lastDailyQuestRewardDate?: string;
  // серия побед
  duelWinStreak?: number;
  streakRewardActive?: boolean;
  /** Бонус за N побед подряд уже выдан на текущем стриме (сброс только при stream.offline) */
  streakBonusAwardedThisStream?: boolean;
}

interface TwitchPlayerStatsRow {
  twitch_username: string;
  twitch_user_id: string | null;
  size: number;
  last_used: number | null;
  last_used_date: string | null;
  points: number;
  duel_timeout_until: number | null;
  duel_cooldown_until: number | null;
  duel_wins: number;
  duel_losses: number;
  duel_draws: number;
  duels_today: number | null;
  last_duel_date: string | null;
  last_daily_quest_reward_date: string | null;
  duel_win_streak: number | null;
  streak_reward_active: boolean | null;
  streak_bonus_awarded_this_stream: boolean | null;
}

function rowToPlayer(r: TwitchPlayerStatsRow): TwitchPlayerData {
  return {
    twitchUsername: r.twitch_username,
    twitchUserId: r.twitch_user_id ?? undefined,
    size: r.size,
    lastUsed: r.last_used || 0,
    lastUsedDate: r.last_used_date || undefined,
    points: r.points,
    duelTimeoutUntil: r.duel_timeout_until || undefined,
    duelCooldownUntil: r.duel_cooldown_until || undefined,
    duelWins: r.duel_wins,
    duelLosses: r.duel_losses,
    duelDraws: r.duel_draws,
    duelsToday: r.duels_today ?? 0,
    lastDuelDate: r.last_duel_date || undefined,
    lastDailyQuestRewardDate: r.last_daily_quest_reward_date || undefined,
    duelWinStreak: r.duel_win_streak ?? 0,
    streakRewardActive: r.streak_reward_active ?? false,
    streakBonusAwardedThisStream: r.streak_bonus_awarded_this_stream ?? false
  };
}

export class TwitchPlayersStorageDB {
  private userIdPersistCache = new Set<string>();

  async loadTwitchPlayers(): Promise<Map<string, TwitchPlayerData>> {
    const rows = await query<TwitchPlayerStatsRow>(`
      SELECT twitch_username, twitch_user_id, size, last_used, last_used_date, points,
        duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws,
        duels_today, last_duel_date, last_daily_quest_reward_date,
        duel_win_streak, streak_reward_active, streak_bonus_awarded_this_stream
      FROM twitch_player_stats
    `);
    const map = new Map<string, TwitchPlayerData>();
    rows.forEach(r => {
      const norm = r.twitch_username.toLowerCase();
      map.set(norm, rowToPlayer(r));
    });
    return map;
  }

  async saveTwitchPlayers(players: Map<string, TwitchPlayerData>): Promise<void> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      for (const [norm, player] of players.entries()) {
        await client.query(
          `INSERT INTO twitch_player_stats (twitch_username, twitch_user_id, size, last_used, last_used_date, points,
            duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws,
            duels_today, last_duel_date, last_daily_quest_reward_date,
            duel_win_streak, streak_reward_active, streak_bonus_awarded_this_stream)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                  $12, $13, $14, $15, $16, $17)
          ON CONFLICT (twitch_username) DO UPDATE SET
            twitch_user_id=COALESCE(EXCLUDED.twitch_user_id, twitch_player_stats.twitch_user_id),
            size=$3, last_used=$4, last_used_date=$5, points=$6,
            duel_timeout_until=$7, duel_cooldown_until=$8, duel_wins=$9, duel_losses=$10, duel_draws=$11,
            duels_today=$12, last_duel_date=$13, last_daily_quest_reward_date=$14,
            duel_win_streak=$15, streak_reward_active=$16, streak_bonus_awarded_this_stream=$17,
            updated_at=CURRENT_TIMESTAMP`,
          [
            norm,
            player.twitchUserId ?? null,
            player.size,
            player.lastUsed,
            player.lastUsedDate || null,
            player.points || 1000,
            player.duelTimeoutUntil || null,
            player.duelCooldownUntil || null,
            player.duelWins || 0,
            player.duelLosses || 0,
            player.duelDraws || 0,
            player.duelsToday ?? 0,
            player.lastDuelDate || null,
            player.lastDailyQuestRewardDate || null,
            player.duelWinStreak ?? 0,
            player.streakRewardActive ?? false,
            player.streakBonusAwardedThisStream ?? false
          ]
        );
      }
    } finally {
      client.release();
    }
  }

  /**
   * Сохранить Twitch user id для логина (без полной загрузки Map).
   * Создаёт строку игрока при первом появлении в чате, если её ещё нет.
   */
  async recordTwitchUserId(twitchUsername: string, twitchUserId: string): Promise<boolean> {
    const norm = twitchUsername.trim().toLowerCase();
    const id = normalizeTwitchUserId(twitchUserId);
    if (!norm || !id) return false;

    const cacheKey = `${norm}:${id}`;
    if (this.userIdPersistCache.has(cacheKey)) return false;

    await query(
      `INSERT INTO twitch_player_stats (twitch_username, twitch_user_id, size, last_used, points)
       VALUES ($1, $2, 0, 0, 1000)
       ON CONFLICT (twitch_username) DO UPDATE SET
         twitch_user_id = EXCLUDED.twitch_user_id,
         updated_at = CURRENT_TIMESTAMP`,
      [norm, id]
    );
    this.userIdPersistCache.add(cacheKey);
    return true;
  }

  async getTwitchUserIdStats(): Promise<{ total: number; withUserId: number }> {
    const row = await queryOne<{ total: number; with_user_id: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(twitch_user_id)::int AS with_user_id
       FROM twitch_player_stats`
    );
    return {
      total: row?.total ?? 0,
      withUserId: row?.with_user_id ?? 0
    };
  }

  async listTwitchUserIds(): Promise<{ twitchUsername: string; twitchUserId: string }[]> {
    const rows = await query<{ twitch_username: string; twitch_user_id: string }>(
      `SELECT twitch_username, twitch_user_id
       FROM twitch_player_stats
       WHERE twitch_user_id IS NOT NULL
       ORDER BY twitch_username`
    );
    return rows.map((r) => ({
      twitchUsername: r.twitch_username,
      twitchUserId: r.twitch_user_id
    }));
  }

  async getTwitchPlayerRank(players: Map<string, TwitchPlayerData>, username: string): Promise<number> {
    const norm = username.toLowerCase();
    const row = await queryOne<{ size: number }>(
      'SELECT size FROM twitch_player_stats WHERE twitch_username = $1',
      [norm]
    );
    if (!row) return players.size + 1;
    const countResult = await queryOne<{ count: number }>(
      'SELECT COUNT(*)::int as count FROM twitch_player_stats WHERE size > $1',
      [row.size]
    );
    const count = countResult?.count ?? 0;
    return (typeof count === 'string' ? parseInt(count, 10) : count) + 1;
  }

  async getTop(limit: number = 10): Promise<TwitchPlayerData[]> {
    const rows = await query<TwitchPlayerStatsRow>(`
      SELECT twitch_username, size, last_used, last_used_date, points,
        duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws
      FROM twitch_player_stats ORDER BY size DESC LIMIT $1
    `, [limit]);
    return rows.map(rowToPlayer);
  }

  async getBottom(limit: number = 10): Promise<TwitchPlayerData[]> {
    const rows = await query<TwitchPlayerStatsRow>(`
      SELECT twitch_username, size, last_used, last_used_date, points,
        duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws
      FROM twitch_player_stats ORDER BY size ASC LIMIT $1
    `, [limit]);
    return rows.map(rowToPlayer);
  }

  async getTopPoints(limit: number = 10): Promise<TwitchPlayerData[]> {
    const rows = await query<TwitchPlayerStatsRow>(`
      SELECT twitch_username, size, last_used, last_used_date, points,
        duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws
      FROM twitch_player_stats ORDER BY points DESC LIMIT $1
    `, [limit]);
    return rows.map(rowToPlayer);
  }
}
