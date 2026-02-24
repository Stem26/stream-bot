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
const DUEL_MISS_PENALTY = 5;
const DUEL_TIMEOUT_MS = 5 * 60 * 1000;
const DUEL_COOLDOWN_MS = 60 * 1000;

// Пользователи без cooldown и timeout (стример)
const DUEL_EXEMPT_USERS = new Set([STREAMER_USERNAME?.toLowerCase()].filter(Boolean));

// Пользователи, которые могут управлять дуэлями (включать/выключать)
const DUEL_ADMINS = new Set([
  STREAMER_USERNAME?.toLowerCase(),
  'stem261',
  'kunila666_bot',
  'remax_7',
  'violent_osling'
].filter(Boolean));

// Флаг состояния дуэлей (включены/выключены)
let duelsEnabled = true;

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
): { response: string; loser?: string; loser2?: string; bothLost?: boolean } {
  // Проверяем, включены ли дуэли
  if (!duelsEnabled) {
    return {
      response: '' // Игнорируем команду, ничего не отвечаем
    };
  }

  const players = loadTwitchPlayers();
  const now = Date.now();
  const normalized = twitchUsername.toLowerCase();
  const player = ensurePlayer(players, twitchUsername);

  // Проверяем exempt от cooldown
  const isExempt = DUEL_EXEMPT_USERS.has(normalized);

  // Проверяем кто в очереди (чтобы решить, нужен ли cooldown check)
  const waiting = duelQueueByChannel.get(channel);
  const waitingIsExempt = waiting ? DUEL_EXEMPT_USERS.has(waiting.username) : false;

  // Проверяем глобальный cooldown дуэлей (если пользователь не exempt)
  // ИСКЛЮЧЕНИЕ: если в очереди стоит exempt пользователь (стример), пропускаем cooldown
  if (!isExempt && !waitingIsExempt) {
    const lastDuelAt = duelCooldownByChannel.get(channel);

    if (lastDuelAt && now - lastDuelAt < DUEL_COOLDOWN_MS) {
      const secondsLeft = Math.ceil((DUEL_COOLDOWN_MS - (now - lastDuelAt)) / 1000);
      return {
        response: `Револьверы ещё не остыли подожди ${secondsLeft} сек.`
      };
    }
  }

  // Проверяем личный timeout игрока (если пользователь не exempt)
  // ИСКЛЮЧЕНИЕ: если в очереди стоит exempt пользователь (стример), пропускаем timeout
  if (!isExempt && !waitingIsExempt && player.duelTimeoutUntil && now < player.duelTimeoutUntil) {
    const minutesLeft = Math.ceil((player.duelTimeoutUntil - now) / 60000);
    return {
      response: `@${twitchUsername}, ты в таймауте ещё ${minutesLeft} мин.`
    };
  }

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
  const currentIsExempt = DUEL_EXEMPT_USERS.has(normalized);
  
  // Специальные исходы дуэли (только если оба не exempt)
  const randomValue = Math.random();
  
  // 5% шанс - оба попали и убили друг друга
  const bothHit = !currentIsExempt && !opponentIsExempt && randomValue < 0.05;
  
  // 5% шанс - оба промахнулись
  const bothMiss = !currentIsExempt && !opponentIsExempt && randomValue >= 0.05 && randomValue < 0.1;

  if (bothHit) {
    // Оба попали: теряют очки и получают таймаут (минимум 0 очков)
    player.points = Math.max(0, (player.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS);
    opponentPlayer.points = Math.max(0, (opponentPlayer.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS);
    player.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
    opponentPlayer.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;

    // Статистика: оба проиграли
    player.duelLosses = (player.duelLosses ?? 0) + 1;
    opponentPlayer.duelLosses = (opponentPlayer.duelLosses ?? 0) + 1;

    duelQueueByChannel.delete(channel);
    duelCooldownByChannel.set(channel, now);
    saveTwitchPlayers(players);

    return {
      response: `@${waiting.displayName} и @${twitchUsername} сошлись в дуэли! Оба попали и убили друг друга! 💀💀 Оба получают (-${DUEL_WIN_POINTS}) очков и таймаут на 5 минут.`,
      loser: waiting.displayName,
      loser2: twitchUsername,
      bothLost: true
    };
  }

  if (bothMiss) {
    player.points = Math.max(0, (player.points ?? DEFAULT_POINTS) - DUEL_MISS_PENALTY);
    opponentPlayer.points = Math.max(0, (opponentPlayer.points ?? DEFAULT_POINTS) - DUEL_MISS_PENALTY);

    // Статистика: ничья
    player.duelDraws = (player.duelDraws ?? 0) + 1;
    opponentPlayer.duelDraws = (opponentPlayer.duelDraws ?? 0) + 1;

    duelQueueByChannel.delete(channel);
    duelCooldownByChannel.set(channel, now);
    saveTwitchPlayers(players);

    return {
      response: `@${waiting.displayName} и @${twitchUsername} сошлись в дуэли! Оба промахнулись! 😅 Живы оба, но позор на всю деревню! (-${DUEL_MISS_PENALTY}) очков каждому.`,
      loser: undefined,
      loser2: undefined,
      bothLost: false
    };
  }

  // Обычная логика дуэли (один победитель)
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
    opponentPlayer.points = Math.max(0, (opponentPlayer.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS);
    // Не ставим timeout если проигравший - exempt пользователь
    if (!opponentIsExempt) {
      opponentPlayer.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
    }
    // Статистика
    player.duelWins = (player.duelWins ?? 0) + 1;
    opponentPlayer.duelLosses = (opponentPlayer.duelLosses ?? 0) + 1;
  } else {
    opponentPlayer.points = (opponentPlayer.points ?? DEFAULT_POINTS) + DUEL_WIN_POINTS;
    player.points = Math.max(0, (player.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS);
    // Не ставим timeout если проигравший - exempt пользователь
    if (!currentIsExempt) {
      player.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
    }
    // Статистика
    opponentPlayer.duelWins = (opponentPlayer.duelWins ?? 0) + 1;
    player.duelLosses = (player.duelLosses ?? 0) + 1;
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
 * Проверяет, может ли пользователь управлять дуэлями
 */
export function canManageDuels(twitchUsername: string): boolean {
  return DUEL_ADMINS.has(twitchUsername.toLowerCase());
}

/**
 * Отключить дуэли
 */
export function disableDuels(twitchUsername: string): boolean {
  if (!canManageDuels(twitchUsername)) {
    return false; // Нет прав
  }
  duelsEnabled = false;
  console.log(`🛑 Дуэли отключены пользователем ${twitchUsername}`);
  return true;
}

/**
 * Включить дуэли
 */
export function enableDuels(twitchUsername: string): boolean {
  if (!canManageDuels(twitchUsername)) {
    return false; // Нет прав
  }
  duelsEnabled = true;
  console.log(`✅ Дуэли включены пользователем ${twitchUsername}`);
  return true;
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

/**
 * Сброс состояния дуэлей при окончании стрима
 */
export function resetDuelsOnStreamEnd(): void {
  duelsEnabled = true;
  console.log('🔄 Дуэли сброшены в состояние "включены" (окончание стрима)');
}

/**
 * Снимает таймауты дуэлей со всех игроков (амнистия)
 * Доступно только админам
 * Возвращает список игроков для снятия реальных таймаутов в Twitch
 */
export function pardonAllDuelTimeouts(twitchUsername: string): { success: boolean; count: number; usernames: string[] } {
  if (!canManageDuels(twitchUsername)) {
    console.log(`⚠️ Пользователь ${twitchUsername} попытался использовать амнистию без прав`);
    return { success: false, count: 0, usernames: [] };
  }

  const players = loadTwitchPlayers();
  const now = Date.now();
  let pardoned = 0;
  const usernamesWithTimeout: string[] = [];

  // Проходим по всем игрокам и снимаем активные таймауты
  for (const [username, player] of players.entries()) {
    if (player.duelTimeoutUntil && player.duelTimeoutUntil > now) {
      delete player.duelTimeoutUntil;
      pardoned++;
      usernamesWithTimeout.push(player.twitchUsername);
    }
  }

  if (pardoned > 0) {
    saveTwitchPlayers(players);
    console.log(`🕊️ Амнистия: снято ${pardoned} таймаутов дуэлей пользователем ${twitchUsername}`);
    console.log(`📋 Игроки для разбана: ${usernamesWithTimeout.join(', ')}`);
  } else {
    console.log(`ℹ️ Амнистия: нет активных таймаутов для снятия`);
  }

  return { success: true, count: pardoned, usernames: usernamesWithTimeout };
}
