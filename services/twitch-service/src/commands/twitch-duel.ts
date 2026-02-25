import { TwitchPlayersStorageDB } from '../services/TwitchPlayersStorageDB';
import { STREAMER_USERNAME } from '../config/env';

// Инициализируем хранилище игроков
const storage = new TwitchPlayersStorageDB();

// Типы данных
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

type DuelQueueEntry = {
  username: string;
  displayName: string;
  joinedAt: number;
};

type DuelChallengeEntry = {
  challenger: string;
  challengerDisplay: string;
  challenged: string;
  challengedDisplay: string;
  createdAt: number;
};

const duelQueueByChannel = new Map<string, DuelQueueEntry>();
const duelCooldownByChannel = new Map<string, number>();
const duelChallengesByChannel = new Map<string, DuelChallengeEntry>();
const DEFAULT_POINTS = 1000;
const DUEL_WIN_POINTS = 25;
const DUEL_MISS_PENALTY = 5;
const DUEL_TIMEOUT_MS = 5 * 60 * 1000; // 5 минут таймаут для проигравшего
const DUEL_COOLDOWN_MS = 60 * 1000; // 1 минута общий КД канала
const DUEL_PLAYER_COOLDOWN_MS = 60 * 1000; // 1 минута личный КД игрока (победитель)
const CHALLENGE_TIMEOUT_MS = 2 * 60 * 1000; // 2 минуты на принятие вызова
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000; // 2 минуты ожидания в общей очереди
const STREAMER_WIN_CHANCE = 0.9; // 90% шанс победы для стримера

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

/**
 * Обработка персонального вызова на дуэль
 */
function handlePersonalChallenge(
  challengerUsername: string,
  challengerNormalized: string,
  targetUsername: string,
  channel: string,
  players: Map<string, TwitchPlayerData>,
  now: number
): { response: string; loser?: string; loser2?: string; bothLost?: boolean } {
  const targetNormalized = targetUsername.toLowerCase().replace('@', '');
  const challengerPlayer = ensurePlayer(players, challengerUsername);
  
  // Нельзя вызвать самого себя
  if (challengerNormalized === targetNormalized) {
    return {
      response: `@${challengerUsername}, нельзя вызвать самого себя на дуэль!`
    };
  }

  // Проверяем, что вызывающий не стоит в общей очереди
  const queueEntry = duelQueueByChannel.get(channel);
  if (queueEntry) {
    // Проверяем таймаут очереди
    if (now - queueEntry.joinedAt <= QUEUE_TIMEOUT_MS) {
      // Очередь ещё активна
      if (queueEntry.username === challengerNormalized) {
        return {
          response: `@${challengerUsername}, ты уже стоишь в очереди на обычную дуэль! Дождись соперника.`
        };
      }
      // Проверяем, что цель не стоит в общей очереди
      if (queueEntry.username === targetNormalized) {
        return {
          response: `@${challengerUsername}, @${targetUsername} уже стоит в очереди на обычную дуэль с другим соперником!`
        };
      }
    } else {
      // Очередь истекла, удаляем её
      duelQueueByChannel.delete(channel);
      console.log(`⏱️ Очередь дуэли истекла для ${queueEntry.displayName} (удалена при персональном вызове)`);
    }
  }

  // Проверяем exempt от cooldown для вызывающего
  const challengerIsExempt = DUEL_EXEMPT_USERS.has(challengerNormalized);

  // Проверяем общий cooldown канала (если вызывающий не exempt)
  if (!challengerIsExempt) {
    const lastDuelAt = duelCooldownByChannel.get(channel);
    if (lastDuelAt && now - lastDuelAt < DUEL_COOLDOWN_MS) {
      const secondsLeft = Math.ceil((DUEL_COOLDOWN_MS - (now - lastDuelAt)) / 1000);
      return {
        response: `Револьверы ещё не остыли, подожди ${secondsLeft} сек.`
      };
    }
  }

  // Проверяем личный timeout вызывающего (если не exempt)
  if (!challengerIsExempt && challengerPlayer.duelTimeoutUntil && now < challengerPlayer.duelTimeoutUntil) {
    const minutesLeft = Math.ceil((challengerPlayer.duelTimeoutUntil - now) / 60000);
    return {
      response: `@${challengerUsername}, ты в таймауте ещё ${minutesLeft} мин.`
    };
  }

  // Проверяем личный cooldown вызывающего (если не exempt)
  if (!challengerIsExempt && challengerPlayer.duelCooldownUntil && now < challengerPlayer.duelCooldownUntil) {
    const secondsLeft = Math.ceil((challengerPlayer.duelCooldownUntil - now) / 1000);
    return {
      response: `@${challengerUsername}, ты недавно участвовал в дуэли, жди ${secondsLeft} сек.`
    };
  }

  // Проверяем, есть ли уже активный вызов для этого пользователя
  const existingChallenge = duelChallengesByChannel.get(channel);
  if (existingChallenge) {
    // Проверяем таймаут вызова
    if (now - existingChallenge.createdAt > CHALLENGE_TIMEOUT_MS) {
      // Вызов истёк, удаляем его
      duelChallengesByChannel.delete(channel);
      console.log(`⏱️ Вызов на дуэль от ${existingChallenge.challenger} к ${existingChallenge.challenged} истёк`);
    } else {
      // Есть активный вызов
      const secondsLeft = Math.ceil((CHALLENGE_TIMEOUT_MS - (now - existingChallenge.createdAt)) / 1000);
      return {
        response: `Уже есть активный вызов от @${existingChallenge.challengerDisplay} к @${existingChallenge.challengedDisplay} (осталось ${secondsLeft} сек)`
      };
    }
  }

  // Создаём новый вызов
  duelChallengesByChannel.set(channel, {
    challenger: challengerNormalized,
    challengerDisplay: challengerUsername,
    challenged: targetNormalized,
    challengedDisplay: targetUsername,
    createdAt: now
  });

  console.log(`⚔️ Создан персональный вызов: ${challengerUsername} -> ${targetUsername} в канале ${channel}`);

  storage.saveTwitchPlayers(players);
  
  return {
    response: `@${challengerUsername} вызывает @${targetUsername} на дуэль! ⚔️ У @${targetUsername} есть 2 минуты, чтобы написать !принять или !отклонить`
  };
}

/**
 * Выполнение дуэли между двумя игроками
 */
function executeDuel(
  player1Username: string,
  player1Normalized: string,
  player2Username: string,
  player2Normalized: string,
  channel: string,
  players: Map<string, TwitchPlayerData>,
  now: number
): { response: string; loser?: string; loser2?: string; bothLost?: boolean } {
  const player1 = ensurePlayer(players, player1Username);
  const player2 = ensurePlayer(players, player2Username);
  
  const player1IsExempt = DUEL_EXEMPT_USERS.has(player1Normalized);
  const player2IsExempt = DUEL_EXEMPT_USERS.has(player2Normalized);
  
  // Специальные исходы дуэли (только если оба не exempt)
  const randomValue = Math.random();
  
  // 5% шанс - оба попали и убили друг друга
  const bothHit = !player1IsExempt && !player2IsExempt && randomValue < 0.05;
  
  // 5% шанс - оба промахнулись
  const bothMiss = !player1IsExempt && !player2IsExempt && randomValue >= 0.05 && randomValue < 0.1;

  if (bothHit) {
    player1.points = Math.max(0, (player1.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS);
    player2.points = Math.max(0, (player2.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS);
    player1.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
    player2.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;

    player1.duelLosses = (player1.duelLosses ?? 0) + 1;
    player2.duelLosses = (player2.duelLosses ?? 0) + 1;

    duelCooldownByChannel.set(channel, now);
    storage.saveTwitchPlayers(players);

    return {
      response: `@${player1Username} и @${player2Username} сошлись в дуэли! Оба попали и убили друг друга! 💀💀 Оба получают (-${DUEL_WIN_POINTS}) очков и таймаут на 5 минут.`,
      loser: player1Username,
      loser2: player2Username,
      bothLost: true
    };
  }

  if (bothMiss) {
    player1.points = Math.max(0, (player1.points ?? DEFAULT_POINTS) - DUEL_MISS_PENALTY);
    player2.points = Math.max(0, (player2.points ?? DEFAULT_POINTS) - DUEL_MISS_PENALTY);

    // Оба промахнулись - ничья, даём обоим КД на 1 минуту
    if (!player1IsExempt) {
      player1.duelCooldownUntil = now + DUEL_PLAYER_COOLDOWN_MS;
    }
    if (!player2IsExempt) {
      player2.duelCooldownUntil = now + DUEL_PLAYER_COOLDOWN_MS;
    }

    player1.duelDraws = (player1.duelDraws ?? 0) + 1;
    player2.duelDraws = (player2.duelDraws ?? 0) + 1;

    duelCooldownByChannel.set(channel, now);
    storage.saveTwitchPlayers(players);

    return {
      response: `@${player1Username} и @${player2Username} сошлись в дуэли! Оба промахнулись! 😅 Живы оба, но позор на всю деревню! (-${DUEL_MISS_PENALTY}) очков каждому.`,
      loser: undefined,
      loser2: undefined,
      bothLost: false
    };
  }

  // Обычная логика дуэли (один победитель)
  let player1Wins: boolean;
  if (player1IsExempt && !player2IsExempt) {
    player1Wins = Math.random() < STREAMER_WIN_CHANCE;
  } else if (!player1IsExempt && player2IsExempt) {
    player1Wins = Math.random() >= STREAMER_WIN_CHANCE;
  } else {
    player1Wins = Math.random() < 0.5;
  }
  
  const winner = player1Wins ? player1Username : player2Username;
  const loser = player1Wins ? player2Username : player1Username;

  if (player1Wins) {
    player1.points = (player1.points ?? DEFAULT_POINTS) + DUEL_WIN_POINTS;
    player2.points = Math.max(0, (player2.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS);
    // Проигравший: 5 минут таймаут
    if (!player2IsExempt) {
      player2.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
    }
    // Победитель: 1 минута КД
    if (!player1IsExempt) {
      player1.duelCooldownUntil = now + DUEL_PLAYER_COOLDOWN_MS;
    }
    player1.duelWins = (player1.duelWins ?? 0) + 1;
    player2.duelLosses = (player2.duelLosses ?? 0) + 1;
  } else {
    player2.points = (player2.points ?? DEFAULT_POINTS) + DUEL_WIN_POINTS;
    player1.points = Math.max(0, (player1.points ?? DEFAULT_POINTS) - DUEL_WIN_POINTS);
    // Проигравший: 5 минут таймаут
    if (!player1IsExempt) {
      player1.duelTimeoutUntil = now + DUEL_TIMEOUT_MS;
    }
    // Победитель: 1 минута КД
    if (!player2IsExempt) {
      player2.duelCooldownUntil = now + DUEL_PLAYER_COOLDOWN_MS;
    }
    player2.duelWins = (player2.duelWins ?? 0) + 1;
    player1.duelLosses = (player1.duelLosses ?? 0) + 1;
  }

  duelCooldownByChannel.set(channel, now);
  storage.saveTwitchPlayers(players);

  return {
    response: `@${player1Username} и @${player2Username} сошлись в дуэли! Победитель @${winner} (+${DUEL_WIN_POINTS}), проигравший @${loser} (-${DUEL_WIN_POINTS}) и в таймаут на 5 минут.`,
    loser
  };
}

export function processTwitchDuelCommand(
    twitchUsername: string,
    channel: string,
    targetUsername?: string
): { response: string; loser?: string; loser2?: string; bothLost?: boolean } {
  // Проверяем, включены ли дуэли
  if (!duelsEnabled) {
    return {
      response: '' // Игнорируем команду, ничего не отвечаем
    };
  }

  const players = storage.loadTwitchPlayers();
  const now = Date.now();
  const normalized = twitchUsername.toLowerCase();
  const player = ensurePlayer(players, twitchUsername);

  // Если указан целевой пользователь - это персональный вызов
  if (targetUsername) {
    return handlePersonalChallenge(twitchUsername, normalized, targetUsername, channel, players, now);
  }

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

  // Проверяем личный cooldown игрока (если пользователь не exempt)
  // ИСКЛЮЧЕНИЕ: если в очереди стоит exempt пользователь (стример), пропускаем cooldown
  if (!isExempt && !waitingIsExempt && player.duelCooldownUntil && now < player.duelCooldownUntil) {
    const secondsLeft = Math.ceil((player.duelCooldownUntil - now) / 1000);
    return {
      response: `@${twitchUsername}, ты недавно участвовал в дуэли, жди ${secondsLeft} сек.`
    };
  }

  // Проверяем, что игрок не участвует в персональном вызове
  const activeChallengeForQueue = duelChallengesByChannel.get(channel);
  if (activeChallengeForQueue) {
    // Проверяем таймаут вызова
    if (now - activeChallengeForQueue.createdAt <= CHALLENGE_TIMEOUT_MS) {
      // Вызов ещё активен
      if (activeChallengeForQueue.challenger === normalized) {
        return {
          response: `@${twitchUsername}, ты уже вызвал @${activeChallengeForQueue.challengedDisplay} на дуэль! Дождись ответа.`
        };
      }
      if (activeChallengeForQueue.challenged === normalized) {
        return {
          response: `@${twitchUsername}, тебя вызвал @${activeChallengeForQueue.challengerDisplay} на дуэль! Напиши !принять или !отклонить`
        };
      }
    } else {
      // Вызов истёк, удаляем его
      duelChallengesByChannel.delete(channel);
      console.log(`⏱️ Вызов на дуэль от ${activeChallengeForQueue.challenger} к ${activeChallengeForQueue.challenged} истёк (удалён при попытке встать в очередь)`);
    }
  }

  // Проверяем таймаут очереди - если истекла, уведомляем и обновляем
  if (waiting && now - waiting.joinedAt > QUEUE_TIMEOUT_MS) {
    console.log(`⏱️ Очередь дуэли истекла для ${waiting.displayName}, соперник не нашёлся, очередь очищена`);
    duelQueueByChannel.delete(channel);
    // После удаления очередь пуста - ставим нового игрока
    duelQueueByChannel.set(channel, { username: normalized, displayName: twitchUsername, joinedAt: now });
    storage.saveTwitchPlayers(players);
    return {
      response: `Очередь истекла. @${twitchUsername} встал в очередь на дуэль. Ждём 2 минуты соперника!`
    };
  }

  if (!waiting) {
    duelQueueByChannel.set(channel, { username: normalized, displayName: twitchUsername, joinedAt: now });
    storage.saveTwitchPlayers(players);
    return {
      response: `@${twitchUsername}, ты встал в очередь на дуэль. Ждём 2 минуты соперника!`
    };
  }

  if (waiting.username === normalized) {
    const secondsLeft = Math.ceil((QUEUE_TIMEOUT_MS - (now - waiting.joinedAt)) / 1000);
    return {
      response: `@${twitchUsername}, ты уже в очереди на дуэль. Ждём соперника ещё ${secondsLeft} сек.`
    };
  }

  // Проверяем, что оба игрока не участвуют в персональном вызове
  const activeChallengeForDuel = duelChallengesByChannel.get(channel);
  if (activeChallengeForDuel) {
    // Проверяем таймаут вызова
    if (now - activeChallengeForDuel.createdAt <= CHALLENGE_TIMEOUT_MS) {
      // Вызов ещё активен
      // Проверяем текущего игрока
      if (activeChallengeForDuel.challenger === normalized) {
        return {
          response: `@${twitchUsername}, ты уже вызвал @${activeChallengeForDuel.challengedDisplay} на дуэль! Дождись ответа.`
        };
      }
      if (activeChallengeForDuel.challenged === normalized) {
        return {
          response: `@${twitchUsername}, тебя вызвал @${activeChallengeForDuel.challengerDisplay} на дуэль! Напиши !принять или !отклонить`
        };
      }
      // Проверяем игрока в очереди
      if (activeChallengeForDuel.challenger === waiting.username) {
        duelQueueByChannel.delete(channel);
        return {
          response: `@${waiting.displayName} уже вызвал @${activeChallengeForDuel.challengedDisplay} на дуэль, очередь отменена.`
        };
      }
      if (activeChallengeForDuel.challenged === waiting.username) {
        duelQueueByChannel.delete(channel);
        return {
          response: `@${waiting.displayName} вызван @${activeChallengeForDuel.challengerDisplay} на персональную дуэль, очередь отменена.`
        };
      }
    } else {
      // Вызов истёк, удаляем его
      duelChallengesByChannel.delete(channel);
      console.log(`⏱️ Персональный вызов истёк: ${activeChallengeForDuel.challenger} -> ${activeChallengeForDuel.challenged} (удалён при начале дуэли из очереди)`);
    }
  }

  // Удаляем из очереди и выполняем дуэль
  duelQueueByChannel.delete(channel);
  
  return executeDuel(
    waiting.displayName,
    waiting.username,
    twitchUsername,
    normalized,
    channel,
    players,
    now
  );
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

  const players = storage.loadTwitchPlayers();
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
    storage.saveTwitchPlayers(players);
    console.log(`🕊️ Амнистия: снято ${pardoned} таймаутов дуэлей пользователем ${twitchUsername}`);
    console.log(`📋 Игроки для разбана: ${usernamesWithTimeout.join(', ')}`);
  } else {
    console.log(`ℹ️ Амнистия: нет активных таймаутов для снятия`);
  }

  return { success: true, count: pardoned, usernames: usernamesWithTimeout };
}

/**
 * Принятие персонального вызова на дуэль
 */
export function acceptDuelChallenge(
  twitchUsername: string,
  channel: string
): { response: string; loser?: string; loser2?: string; bothLost?: boolean } {
  if (!duelsEnabled) {
    return {
      response: ''
    };
  }

  const players = storage.loadTwitchPlayers();
  const now = Date.now();
  const normalized = twitchUsername.toLowerCase();
  
  // Проверяем, есть ли активный вызов
  const challenge = duelChallengesByChannel.get(channel);
  
  if (!challenge) {
    return {
      response: `@${twitchUsername}, нет активных вызовов на дуэль`
    };
  }

  // Проверяем таймаут вызова
  if (now - challenge.createdAt > CHALLENGE_TIMEOUT_MS) {
    duelChallengesByChannel.delete(channel);
    return {
      response: `@${twitchUsername}, вызов на дуэль истёк`
    };
  }

  // Проверяем, что принимает именно вызванный игрок
  if (challenge.challenged !== normalized) {
    return {
      response: `@${twitchUsername}, этот вызов не для тебя! Вызван @${challenge.challengedDisplay}`
    };
  }

  const challengedPlayer = ensurePlayer(players, twitchUsername);
  const challengedIsExempt = DUEL_EXEMPT_USERS.has(normalized);
  const challengerIsExempt = DUEL_EXEMPT_USERS.has(challenge.challenger);

  // Проверяем личный timeout принимающего (если не exempt)
  if (!challengedIsExempt && challengedPlayer.duelTimeoutUntil && now < challengedPlayer.duelTimeoutUntil) {
    const minutesLeft = Math.ceil((challengedPlayer.duelTimeoutUntil - now) / 60000);
    duelChallengesByChannel.delete(channel);
    return {
      response: `@${twitchUsername}, ты в таймауте ещё ${minutesLeft} мин. Вызов отменён.`
    };
  }

  // Проверяем личный cooldown принимающего (если не exempt)
  // ИСКЛЮЧЕНИЕ: если вызвал exempt пользователь (стример), пропускаем cooldown
  if (!challengedIsExempt && !challengerIsExempt && challengedPlayer.duelCooldownUntil && now < challengedPlayer.duelCooldownUntil) {
    const secondsLeft = Math.ceil((challengedPlayer.duelCooldownUntil - now) / 1000);
    duelChallengesByChannel.delete(channel);
    return {
      response: `@${twitchUsername}, ты недавно участвовал в дуэли, жди ${secondsLeft} сек. Вызов отменён.`
    };
  }

  // Проверяем, что никто из участников не стоит в общей очереди
  const queueEntry = duelQueueByChannel.get(channel);
  if (queueEntry) {
    // Проверяем таймаут очереди
    if (now - queueEntry.joinedAt <= QUEUE_TIMEOUT_MS) {
      // Очередь ещё активна
      if (queueEntry.username === challenge.challenger) {
        duelChallengesByChannel.delete(channel);
        duelQueueByChannel.delete(channel);
        return {
          response: `@${challenge.challengerDisplay} уже стоит в очереди на обычную дуэль. Вызов отменён.`
        };
      }
      if (queueEntry.username === challenge.challenged) {
        duelChallengesByChannel.delete(channel);
        duelQueueByChannel.delete(channel);
        return {
          response: `@${twitchUsername}, ты уже стоишь в очереди на обычную дуэль. Вызов отменён.`
        };
      }
    } else {
      // Очередь истекла, удаляем её
      duelQueueByChannel.delete(channel);
      console.log(`⏱️ Очередь дуэли истекла для ${queueEntry.displayName} (удалена при принятии вызова)`);
    }
  }

  // Удаляем вызов и выполняем дуэль
  duelChallengesByChannel.delete(channel);
  
  console.log(`✅ Вызов принят: ${twitchUsername} принимает вызов от ${challenge.challengerDisplay}`);
  
  return executeDuel(
    challenge.challengerDisplay,
    challenge.challenger,
    challenge.challengedDisplay,
    challenge.challenged,
    channel,
    players,
    now
  );
}

/**
 * Отклонение персонального вызова на дуэль
 */
export function declineDuelChallenge(
  twitchUsername: string,
  channel: string
): { response: string } {
  if (!duelsEnabled) {
    return {
      response: ''
    };
  }

  const now = Date.now();
  const normalized = twitchUsername.toLowerCase();
  
  // Проверяем, есть ли активный вызов
  const challenge = duelChallengesByChannel.get(channel);
  
  if (!challenge) {
    return {
      response: `@${twitchUsername}, нет активных вызовов на дуэль`
    };
  }

  // Проверяем таймаут вызова
  if (now - challenge.createdAt > CHALLENGE_TIMEOUT_MS) {
    duelChallengesByChannel.delete(channel);
    return {
      response: `@${twitchUsername}, вызов на дуэль уже истёк`
    };
  }

  // Проверяем, что отклоняет именно вызванный игрок
  if (challenge.challenged !== normalized) {
    return {
      response: `@${twitchUsername}, этот вызов не для тебя!`
    };
  }

  // Удаляем вызов
  duelChallengesByChannel.delete(channel);
  
  console.log(`🏳️ Вызов отклонён: ${twitchUsername} отклонил вызов от ${challenge.challengerDisplay}`);
  
  return {
    response: `@${twitchUsername} отклонил вызов от @${challenge.challengerDisplay} 🏳️`
  };
}

/**
 * Очистка персональных вызовов (вызывается при окончании стрима)
 */
export function clearDuelChallenges(): void {
  const challengesCount = duelChallengesByChannel.size;
  duelChallengesByChannel.clear();
  if (challengesCount > 0) {
    console.log(`🧹 Персональные вызовы очищены (было ${challengesCount} вызовов)`);
  }
}
