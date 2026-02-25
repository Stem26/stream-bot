import { getDatabase } from '../database/database';

export interface TwitchPlayerData {
  twitchUsername: string;
  size: number;
  lastUsed: number;
  lastUsedDate?: string;
  points?: number;
  duelTimeoutUntil?: number;
  duelCooldownUntil?: number;
  duelWins?: number;
  duelLosses?: number;
  duelDraws?: number;
}

interface TwitchPlayerStatsRow {
  twitch_username: string;
  size: number;
  last_used: number | null;
  last_used_date: string | null;
  points: number;
  duel_timeout_until: number | null;
  duel_cooldown_until: number | null;
  duel_wins: number;
  duel_losses: number;
  duel_draws: number;
}

export class TwitchPlayersStorageDB {
  loadTwitchPlayers(): Map<string, TwitchPlayerData> {
    const rows = getDatabase().prepare(`
      SELECT twitch_username, size, last_used, last_used_date, points,
        duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws
      FROM twitch_player_stats
    `).all() as TwitchPlayerStatsRow[];
    const map = new Map<string, TwitchPlayerData>();
    rows.forEach(r => {
      const norm = r.twitch_username.toLowerCase();
      map.set(norm, {
        twitchUsername: r.twitch_username,
        size: r.size,
        lastUsed: r.last_used || 0,
        lastUsedDate: r.last_used_date || undefined,
        points: r.points,
        duelTimeoutUntil: r.duel_timeout_until || undefined,
        duelCooldownUntil: r.duel_cooldown_until || undefined,
        duelWins: r.duel_wins,
        duelLosses: r.duel_losses,
        duelDraws: r.duel_draws
      });
    });
    return map;
  }

  saveTwitchPlayers(players: Map<string, TwitchPlayerData>): void {
    const db = getDatabase();
    db.transaction(() => {
      for (const [norm, player] of players.entries()) {
        const row = db.prepare('SELECT twitch_username FROM twitch_player_stats WHERE twitch_username = ?').get(norm);
        if (!row) {
          db.prepare(`
            INSERT INTO twitch_player_stats (twitch_username, size, last_used, last_used_date, points,
              duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            norm, player.size, player.lastUsed, player.lastUsedDate || null, player.points || 1000,
            player.duelTimeoutUntil || null, player.duelCooldownUntil || null,
            player.duelWins || 0, player.duelLosses || 0, player.duelDraws || 0
          );
        } else {
          db.prepare(`
            UPDATE twitch_player_stats SET size=?, last_used=?, last_used_date=?, points=?,
              duel_timeout_until=?, duel_cooldown_until=?, duel_wins=?, duel_losses=?, duel_draws=?,
              updated_at=CURRENT_TIMESTAMP WHERE twitch_username=?
          `).run(
            player.size, player.lastUsed, player.lastUsedDate || null, player.points || 1000,
            player.duelTimeoutUntil || null, player.duelCooldownUntil || null,
            player.duelWins || 0, player.duelLosses || 0, player.duelDraws || 0, norm
          );
        }
      }
    })();
  }

  getTwitchPlayerRank(players: Map<string, TwitchPlayerData>, username: string): number {
    const norm = username.toLowerCase();
    const row = getDatabase().prepare('SELECT size FROM twitch_player_stats WHERE twitch_username = ?').get(norm) as { size: number } | undefined;
    if (!row) return players.size + 1;
    const count = getDatabase().prepare('SELECT COUNT(*) as count FROM twitch_player_stats WHERE size > ?').get(row.size) as { count: number };
    return count.count + 1;
  }

  getTop(limit: number = 10): TwitchPlayerData[] {
    const rows = getDatabase().prepare(`
      SELECT twitch_username, size, last_used, last_used_date, points,
        duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws
      FROM twitch_player_stats ORDER BY size DESC LIMIT ?
    `).all(limit) as TwitchPlayerStatsRow[];
    return rows.map(r => ({
      twitchUsername: r.twitch_username,
      size: r.size,
      lastUsed: r.last_used || 0,
      lastUsedDate: r.last_used_date || undefined,
      points: r.points,
      duelTimeoutUntil: r.duel_timeout_until || undefined,
      duelCooldownUntil: r.duel_cooldown_until || undefined,
      duelWins: r.duel_wins,
      duelLosses: r.duel_losses,
      duelDraws: r.duel_draws
    }));
  }

  getBottom(limit: number = 10): TwitchPlayerData[] {
    const rows = getDatabase().prepare(`
      SELECT twitch_username, size, last_used, last_used_date, points,
        duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws
      FROM twitch_player_stats ORDER BY size ASC LIMIT ?
    `).all(limit) as TwitchPlayerStatsRow[];
    return rows.map(r => ({
      twitchUsername: r.twitch_username,
      size: r.size,
      lastUsed: r.last_used || 0,
      lastUsedDate: r.last_used_date || undefined,
      points: r.points,
      duelTimeoutUntil: r.duel_timeout_until || undefined,
      duelCooldownUntil: r.duel_cooldown_until || undefined,
      duelWins: r.duel_wins,
      duelLosses: r.duel_losses,
      duelDraws: r.duel_draws
    }));
  }

  getTopPoints(limit: number = 10): TwitchPlayerData[] {
    const rows = getDatabase().prepare(`
      SELECT twitch_username, size, last_used, last_used_date, points,
        duel_timeout_until, duel_cooldown_until, duel_wins, duel_losses, duel_draws
      FROM twitch_player_stats ORDER BY points DESC LIMIT ?
    `).all(limit) as TwitchPlayerStatsRow[];
    return rows.map(r => ({
      twitchUsername: r.twitch_username,
      size: r.size,
      lastUsed: r.last_used || 0,
      lastUsedDate: r.last_used_date || undefined,
      points: r.points,
      duelTimeoutUntil: r.duel_timeout_until || undefined,
      duelCooldownUntil: r.duel_cooldown_until || undefined,
      duelWins: r.duel_wins,
      duelLosses: r.duel_losses,
      duelDraws: r.duel_draws
    }));
  }
}
