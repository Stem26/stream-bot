import { loadTwitchPlayers, saveTwitchPlayers, TwitchPlayerData } from '../storage/twitch-players';
import { STREAMER_USERNAME } from '../config/env';

type DuelQueueEntry = {
  username: string;
  displayName: string;
  joinedAt: number;
};

const duelQueueByChannel = new Map<string, DuelQueueEntry>();
const duelCooldownByChannel = new Map<string, number>();
const DEFAULT_POINTS = 1000;
const DUEL_WIN_POINTS = 25;
const DUEL_TIMEOUT_MS = 5 * 60 * 1000;
const DUEL_COOLDOWN_MS = 60 * 1000;

// Пользователи без cooldown и timeout (стример)
const DUEL_EXEMPT_USERS = new Set([STREAMER_USERNAME?.toLowerCase()].filter(Boolean));

function ensurePlayer(players: Map<string, TwitchPlayerData>, twitchUsername: string): TwitchPlayerData {
  const normalized = twitchUsername.toLowerCase();
  let player = players.get(normalized);

  if (!player) {
    player = {
      twitchUsername,
      size: 0,
      lastUsed: 0,
      lastUsedDate: undefined,
      points: DEFAULT_POINTS
    };
    players.set(normalized, player);
    return player;
  }

  if (player.points === undefined) {
    player.points = DEFAULT_POINTS;
  }
  if (player.size === undefined) {
    player.size = 0;
  }
  if (player.lastUsed === undefined) {
    player.lastUsed = 0;
  }
  player.twitchUsername = twitchUsername;
  players.set(normalized, player);

  return player;
}

export function processTwitchDuelCommand(
    twitchUsername: string,
    channel: string
): { response: string; loser?: string } {
  const players = loadTwitchPlayers();
  const now = Date.now();
  const normalized = twitchUsername.toLowerCase();
  const player = ensurePlayer(players, twitchUsername);

  // Проверяем exempt от cooldown
  const isExempt = DUEL_EXEMPT_USERS.has(normalized);

  // Проверяем глобальный cooldown дуэлей (если пользователь не exempt)
  if (!isExempt) {
    const lastDuelAt = duelCooldownByChannel.get(channel);

    if (lastDuelAt && now - lastDuelAt < DUEL_COOLDOWN_MS) {
      const secondsLeft = Math.ceil((DUEL_COOLDOWN_MS - (now - lastDuelAt)) / 1000);
      return {
        response: `Револьверы ещё не остыли подожди ${secondsLeft} сек.`
      };
    }
  }

  // Проверяем личный timeout игрока (если пользователь не exempt)
  if (!isExempt && player.duelTimeoutUntil && now < player.duelTimeoutUntil) {
    const minutesLeft = Math.ceil((player.duelTimeoutUntil - now) / 60000);
    return {
      response: `@${twitchUsername}, ты в таймауте ещё ${minutesLeft} мин.`
    };
  }

  // Проверяем минимальное количество очков (если пользователь не exempt)
  if (!isExempt && (player.points ?? DEFAULT_POINTS) < DUEL_WIN_POINTS) {
    return {
      response: `@${twitchUsername}, у тебя недостаточно очков для дуэли (минимум ${DUEL_WIN_POINTS}).`
    };
  }

  const waiting = duelQueueByChannel.get(channel);

  if (!waiting) {
    duelQueueByChannel.set(channel, { username: normalized, displayName: twitchUsername, joinedAt: now });
    saveTwitchPlayers(players);
    return {
      response: `@${twitchUsername}, ты встал в очередь на дуэль. Ждём соперника!`
    };
  }

  if (waiting.username === normalized) {
    return {
      response: `@${twitchUsername}, ты уже в очереди на дуэль. Ждём соперника!`
    };
  }

  const opponentPlayer = ensurePlayer(players, waiting.displayName);

  const opponentIsExempt = DUEL_EXEMPT_USERS.has(waiting.username);
  if (!opponentIsExempt && (opponentPlayer.points ?? DEFAULT_POINTS) < DUEL_WIN_POINTS) {
    duelQueueByChannel.delete(channel);
    duelQueueByChannel.set(channel, { username: normalized, displayName: twitchUsername, joinedAt: now });
    saveTwitchPlayers(players);
    return {
      response: `@${waiting.displayName} вылетел из очереди (мало очков). @${twitchUsername}, ты теперь в очереди на дуэль!`
    };
  }

  const currentIsExempt = DUEL_EXEMPT_USERS.has(normalized);
  
  let winnerIsCurrent: boolean;
  if (currentIsExempt && !opponentIsExempt) {
    // Текущий игрок - стример, он побеждает
    winnerIsCurrent = true;
  } else if (!currentIsExempt && opponentIsExempt) {
    winnerIsCurrent = false;
  } else {
    winnerIsCurrent = Math.random() < 0.5;
  }
  
  const winner = winnerIsCurrent ? twitchUsername : waiting.displayName;
  const loser = winnerIsCurrent ? waiting.displayName : twitchUsername;

  if (winnerIsCurrent) {
    player.points = (player.points ?? DEFAULT_POINTS) + DUEL_WIN_POINTS;
    opponentPlayer.points = (opponentPlayer.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS;
    // Не ставим timeout если проигравший - exempt пользователь
    if (!opponentIsExempt) {
      opponentPlayer.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
    }
  } else {
    opponentPlayer.points = (opponentPlayer.points ?? DEFAULT_POINTS) + DUEL_WIN_POINTS;
    player.points = (player.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS;
    // Не ставим timeout если проигравший - exempt пользователь
    if (!currentIsExempt) {
      player.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
    }
  }

  duelQueueByChannel.delete(channel);
  duelCooldownByChannel.set(channel, now);
  saveTwitchPlayers(players);

  return {
    response: `@${waiting.displayName} и @${twitchUsername} сошлись в дуэли! Победитель @${winner} (+${DUEL_WIN_POINTS}), проигравший @${loser} (-${DUEL_WIN_POINTS}) и в таймаут на 5 минут.`,
    loser
  };
}

/**
 * Очистка очереди на дуэли (вызывается при окончании стрима)
 */
export function clearDuelQueue(): void {
  const queueSize = duelQueueByChannel.size;
  duelQueueByChannel.clear();
  if (queueSize > 0) {
    console.log(`🧹 Очередь на дуэли очищена (было ${queueSize} игроков)`);
  }
}
