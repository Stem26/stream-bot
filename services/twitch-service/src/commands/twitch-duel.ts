import { TwitchPlayersStorageDB } from '../services/TwitchPlayersStorageDB';
import { STREAMER_USERNAME } from '../config/env';
import {
  sendOverlayDuel,
  sendOverlayDuelSafe,
  waitOverlayDuelCompleteEvent,
  DuelMode,
} from '../services/overlay-api';
import { query, queryOne } from '../database/database';

const storage = new TwitchPlayersStorageDB();

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
  duelsToday?: number;
  lastDuelDate?: string;
  lastDailyQuestRewardDate?: string;
  duelWinStreak?: number;
  streakRewardActive?: boolean;
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

export type DuelCommandResult = {
  response: string;
  loser?: string;
  loser2?: string;
  bothLost?: boolean;
  extraMessages?: string[];
  postOverlayMessage?: Promise<string | undefined>;
};

// Храним несколько вызовов: Map<channel, Map<challengeId, DuelChallengeEntry>>
// challengeId формируется как "challenger_challenged" (оба normalized)
const duelQueueByChannel = new Map<string, DuelQueueEntry>();
const duelCooldownByChannel = new Map<string, number>();
/** Последняя дуэль с участием бота в канале — не чаще BOT_DUEL_COOLDOWN_MS между такими дуэлями */
const duelBotCooldownByChannel = new Map<string, number>();
const duelChallengesByChannel = new Map<string, Map<string, DuelChallengeEntry>>();
const DEFAULT_POINTS = 1000;
export type DuelConfig = { timeoutMinutes: number; winPoints: number; lossPoints: number; missPenalty: number };

let duelConfig: DuelConfig = { timeoutMinutes: 5, winPoints: 25, lossPoints: 25, missPenalty: 5 };

export function getDuelConfig(): DuelConfig {
  return { ...duelConfig };
}

export function setDuelConfig(c: Partial<DuelConfig>): void {
  if (c.timeoutMinutes != null && c.timeoutMinutes >= 0) duelConfig.timeoutMinutes = c.timeoutMinutes;
  if (c.winPoints != null && c.winPoints >= 0) duelConfig.winPoints = c.winPoints;
  if (c.lossPoints != null && c.lossPoints >= 0) duelConfig.lossPoints = c.lossPoints;
  if (c.missPenalty != null && c.missPenalty >= 0) duelConfig.missPenalty = c.missPenalty;
}

function getDuelTimeoutMs(): number {
  return duelConfig.timeoutMinutes * 60 * 1000;
}

/** Длительность таймаута в секундах для Twitch API (бан в чате) */
export function getDuelTimeoutSeconds(): number {
  return Math.max(1, Math.ceil(getDuelTimeoutMs() / 1000));
}

const DUEL_COOLDOWN_MS = 60 * 1000; // 1 минута общий КД канала
const DUEL_PLAYER_COOLDOWN_MS = 60 * 1000; // 1 минута личный КД игрока (победитель)
/** КД после дуэли с аккаунтом бота (антиспам фарма очков на авто-принятии) */
const BOT_DUEL_COOLDOWN_MS = 10 * 60 * 1000;
const CHALLENGE_TIMEOUT_MS = 2 * 60 * 1000; // 2 минуты на принятие вызова
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000; // 2 минуты ожидания в общей очереди
const STREAMER_WIN_CHANCE = 0.9; // 90% шанс победы для стримера

export type DailyQuestConfig = {
  dailyGamesCount: number;
  dailyRewardPoints: number;
  streakWinsCount: number;
  streakRewardPoints: number;
};

let dailyQuestConfig: DailyQuestConfig = {
  dailyGamesCount: 5,
  dailyRewardPoints: 50,
  streakWinsCount: 3,
  streakRewardPoints: 100,
};

export function getDailyQuestConfig(): DailyQuestConfig {
  return { ...dailyQuestConfig };
}

export function setDailyQuestConfig(c: Partial<DailyQuestConfig>): void {
  if (c.dailyGamesCount != null && c.dailyGamesCount >= 0) dailyQuestConfig.dailyGamesCount = c.dailyGamesCount;
  if (c.dailyRewardPoints != null && c.dailyRewardPoints >= 0) dailyQuestConfig.dailyRewardPoints = c.dailyRewardPoints;
  if (c.streakWinsCount != null && c.streakWinsCount >= 0) dailyQuestConfig.streakWinsCount = c.streakWinsCount;
  if (c.streakRewardPoints != null && c.streakRewardPoints >= 0) dailyQuestConfig.streakRewardPoints = c.streakRewardPoints;
}

// Пользователи без cooldown и timeout (стример)
const DUEL_EXEMPT_USERS = new Set([STREAMER_USERNAME?.toLowerCase()].filter(Boolean));

// Дополнительные пользователи, которые всегда могут управлять дуэлями (помимо модераторов)
const EXTRA_DUEL_ADMINS = new Set([
  STREAMER_USERNAME?.toLowerCase(),
  'stem261',
].filter(Boolean));

// Динамический список админов дуэлей на основе модераторов Twitch
let dynamicDuelAdmins = new Set<string>();
export function setDuelAdminsFromModerators(usernames: string[]): void {
  dynamicDuelAdmins = new Set(usernames.map(name => name.toLowerCase()));
  console.log('✅ DUEL_ADMINS обновлён из списка модераторов:', Array.from(dynamicDuelAdmins).join(', '));
}

// Флаг состояния дуэлей (включены/выключены)
let duelsEnabled = true;
// Флаг синхронизации дуэлей с оверлеем (сообщение в 2 этапа)
let duelOverlaySyncEnabled = false;
let duelOverlaySyncLoadedFromDb = false;

type DuelConfigDbRow = {
  overlay_sync_enabled?: boolean;
};

async function loadDuelOverlaySyncFromDb(): Promise<void> {
  try {
    const row = await queryOne<DuelConfigDbRow>(
      'SELECT overlay_sync_enabled FROM duel_config WHERE id = 1'
    );
    if (row && typeof row.overlay_sync_enabled === 'boolean') {
      duelOverlaySyncEnabled = row.overlay_sync_enabled;
      console.log(
        `✅ Duel overlay sync загружен из БД: ${duelOverlaySyncEnabled ? 'ВКЛ' : 'ВЫКЛ'}`
      );
    } else {
      console.log(
        `ℹ️ Duel overlay sync в БД не найден, используем дефолт: ${duelOverlaySyncEnabled ? 'ВКЛ' : 'ВЫКЛ'}`
      );
    }
  } catch (error: any) {
    console.error(
      '⚠️ Ошибка загрузки duel overlay sync из БД:',
      error?.message || error
    );
  } finally {
    duelOverlaySyncLoadedFromDb = true;
  }
}

async function ensureDuelOverlaySyncLoadedFromDb(): Promise<void> {
  if (duelOverlaySyncLoadedFromDb) return;
  await loadDuelOverlaySyncFromDb();
}

function persistDuelOverlaySyncToDb(enabled: boolean): void {
  void query(
    'UPDATE duel_config SET overlay_sync_enabled = $1 WHERE id = 1',
    [enabled]
  ).catch((error: any) => {
    console.error(
      '⚠️ Ошибка сохранения duel overlay sync в БД:',
      error?.message || error
    );
  });
}

/** Отключить КД 1 мин (канал + игрок) — для тестов, можно спамить дуэли */
let duelCooldownSkipped = false;
export function getDuelCooldownSkipped(): boolean {
  return duelCooldownSkipped;
}
export function setDuelCooldownSkipped(skip: boolean): void {
  duelCooldownSkipped = skip;
}

/** Логин аккаунта, от которого бот пишет в чат (из OAuth validate). Если цель персонального вызова совпадает — бот сразу принимает дуэль. */
let duelResponderLogin: string | null = null;
export function setDuelResponderLogin(login: string | null | undefined): void {
  duelResponderLogin = login ? login.trim().toLowerCase() : null;
}

function markBotDuelParticipationCooldown(
  channel: string,
  player1Normalized: string,
  player2Normalized: string,
  now: number
): void {
  if (duelCooldownSkipped || !duelResponderLogin) return;
  const b = duelResponderLogin;
  if (player1Normalized === b || player2Normalized === b) {
    duelBotCooldownByChannel.set(channel, now);
    console.log(`⏱️ КД дуэли с ботом: ${BOT_DUEL_COOLDOWN_MS / 60000} мин (канал ${channel})`);
  }
}

/** Вызывается при изменении списка забаненных (дуэль/амнистия) — для реал-тайм обновления админки по WebSocket */
let onDuelBannedListChanged: (() => void) | null = null;
export function setOnDuelBannedListChanged(fn: (() => void) | null): void {
  onDuelBannedListChanged = fn;
}

function ensurePlayer(players: Map<string, TwitchPlayerData>, twitchUsername: string): TwitchPlayerData {
  const normalized = twitchUsername.toLowerCase();
  let player = players.get(normalized);

  if (!player) {
    player = {
      twitchUsername,
      size: 0,
      lastUsed: 0,
      lastUsedDate: undefined,
      points: DEFAULT_POINTS,
      duelsToday: 0,
      lastDuelDate: undefined,
      lastDailyQuestRewardDate: undefined,
      duelWinStreak: 0,
      streakRewardActive: false
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
  if (player.duelsToday === undefined) {
    player.duelsToday = 0;
  }
  if (player.duelWinStreak === undefined) {
    player.duelWinStreak = 0;
  }
  if (player.streakRewardActive === undefined) {
    player.streakRewardActive = false;
  }
  player.twitchUsername = twitchUsername;
  players.set(normalized, player);

  return player;
}

/**
 * Получить все вызовы для канала
 */
function getChallengesForChannel(channel: string): Map<string, DuelChallengeEntry> {
  let challenges = duelChallengesByChannel.get(channel);
  if (!challenges) {
    challenges = new Map();
    duelChallengesByChannel.set(channel, challenges);
  }
  return challenges;
}

/**
 * Проверить, участвует ли пользователь в каком-либо вызове (как challenger или challenged)
 */
function findUserChallenge(channel: string, username: string): DuelChallengeEntry | undefined {
  const challenges = getChallengesForChannel(channel);
  console.log(`🔎 findUserChallenge: ищем ${username} в канале ${channel}, всего вызовов: ${challenges.size}`);
  
  for (const [challengeId, challenge] of challenges) {
    console.log(`   - Проверяем вызов ${challengeId}: ${challenge.challenger} -> ${challenge.challenged}`);
    if (challenge.challenger === username || challenge.challenged === username) {
      console.log(`   ✅ НАЙДЕН! ${username} участвует в вызове ${challenge.challengerDisplay} -> ${challenge.challengedDisplay}`);
      return challenge;
    }
  }
  
  console.log(`   ❌ Не найдено вызовов с участием ${username}`);
  return undefined;
}

/**
 * Удалить все вызовы, в которых участвует пользователь (как challenger или challenged)
 */
function clearUserChallenges(channel: string, username: string): void {
  const challenges = getChallengesForChannel(channel);
  const toDelete: string[] = [];
  
  for (const [challengeId, challenge] of challenges) {
    if (challenge.challenger === username || challenge.challenged === username) {
      toDelete.push(challengeId);
      console.log(`🧹 Удаляем вызов: ${challenge.challengerDisplay} -> ${challenge.challengedDisplay}`);
    }
  }
  
  for (const id of toDelete) {
    challenges.delete(id);
  }
}

/**
 * Очистить устаревшие вызовы в канале
 */
function cleanExpiredChallenges(channel: string, now: number): void {
  const challenges = getChallengesForChannel(channel);
  const toDelete: string[] = [];
  
  for (const [challengeId, challenge] of challenges) {
    if (now - challenge.createdAt > CHALLENGE_TIMEOUT_MS) {
      toDelete.push(challengeId);
      console.log(`⏱️ Вызов на дуэль от ${challenge.challengerDisplay} к ${challenge.challengedDisplay} истёк`);
    }
  }
  
  for (const id of toDelete) {
    challenges.delete(id);
  }
}

/**
 * Очистить ВСЕ вызовы в канале (используется после начала любой дуэли, т.к. включается cooldown)
 */
function clearAllChallengesInChannel(channel: string, reason: string = 'Дуэль началась, cooldown активен'): void {
  const challenges = getChallengesForChannel(channel);
  const count = challenges.size;
  
  if (count > 0) {
    console.log(`🧹 Очистка всех вызовов в канале ${channel}: ${count} вызовов (причина: ${reason})`);
    for (const [_, challenge] of challenges) {
      console.log(`   - Отменён вызов: ${challenge.challengerDisplay} -> ${challenge.challengedDisplay}`);
    }
    challenges.clear();
  }
}

/**
 * Обработка персонального вызова на дуэль
 */
async function handlePersonalChallenge(
  challengerUsername: string,
  challengerNormalized: string,
  targetUsername: string,
  channel: string,
  players: Map<string, TwitchPlayerData>,
  now: number
): Promise<DuelCommandResult> {
  // Очищаем имя от @ и невидимых символов
  let cleanTarget = targetUsername.toLowerCase().replace(/^@+/, '');
  cleanTarget = cleanTarget.replace(/[\u200B-\u200D\uFEFF\u034F\u061C\u180E]/g, '').trim();
  
  // Если после очистки осталась пустая строка, это невалидное имя
  if (!cleanTarget || cleanTarget.length === 0) {
    return {
      response: `@${challengerUsername}, укажи корректное имя пользователя для вызова на дуэль!`
    };
  }
  
  const targetNormalized = cleanTarget;
  const challengerPlayer = ensurePlayer(players, challengerUsername);
  
  // Нельзя вызвать самого себя
  if (challengerNormalized === targetNormalized) {
    return {
      response: `@${challengerUsername}, нельзя вызвать самого себя на дуэль!`
    };
  }

  // Очищаем устаревшие вызовы
  cleanExpiredChallenges(channel, now);

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

  // Проверяем общий cooldown канала (если вызывающий не exempt), если не отключён для тестов
  if (!duelCooldownSkipped && !challengerIsExempt) {
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

  // Проверяем личный cooldown вызывающего (если не exempt), если не отключён для тестов
  if (!duelCooldownSkipped && !challengerIsExempt && challengerPlayer.duelCooldownUntil && now < challengerPlayer.duelCooldownUntil) {
    const secondsLeft = Math.ceil((challengerPlayer.duelCooldownUntil - now) / 1000);
    return {
      response: `@${challengerUsername}, ты недавно участвовал в дуэли, жди ${secondsLeft} сек.`
    };
  }

  // Проверяем, участвует ли вызывающий в другом вызове
  const challengerExistingChallenge = findUserChallenge(channel, challengerNormalized);
  console.log(`🔍 Проверка вызовов для ${challengerNormalized} в канале ${channel}: ${challengerExistingChallenge ? 'НАЙДЕН' : 'НЕ НАЙДЕН'}`);
  if (challengerExistingChallenge) {
    console.log(`⚠️ Попытка второго вызова: ${challengerNormalized} уже участвует в вызове ${challengerExistingChallenge.challengerDisplay} -> ${challengerExistingChallenge.challengedDisplay}`);
    if (challengerExistingChallenge.challenger === challengerNormalized) {
      return {
        response: `@${challengerUsername}, ты уже вызвал @${challengerExistingChallenge.challengedDisplay} на дуэль! Дождись ответа.`
      };
    } else {
      // Проверяем, пытается ли вызвать обратно того, кто его вызвал
      if (challengerExistingChallenge.challenger === targetNormalized) {
        return {
          response: `@${challengerUsername}, @${challengerExistingChallenge.challengerDisplay} уже вызвал тебя на дуэль! Напиши !принять чтобы начать бой`
        };
      }
      return {
        response: `@${challengerUsername}, тебя уже вызвал @${challengerExistingChallenge.challengerDisplay} на дуэль! Напиши !принять или !отклонить`
      };
    }
  }

  // Проверяем, участвует ли цель в другом вызове
  const targetExistingChallenge = findUserChallenge(channel, targetNormalized);
  if (targetExistingChallenge) {
    if (targetExistingChallenge.challenger === targetNormalized) {
      return {
        response: `@${challengerUsername}, @${targetUsername} уже вызвал кого-то на дуэль, дождись окончания.`
      };
    } else {
      return {
        response: `@${challengerUsername}, @${targetUsername} уже вызван @${targetExistingChallenge.challengerDisplay} на дуэль, дождись окончания.`
      };
    }
  }

  // Антифарм: дуэль с ботом не чаще чем раз в BOT_DUEL_COOLDOWN_MS
  if (
    duelResponderLogin &&
    targetNormalized === duelResponderLogin &&
    !duelCooldownSkipped
  ) {
    const lastBotDuel = duelBotCooldownByChannel.get(channel);
    if (lastBotDuel && now - lastBotDuel < BOT_DUEL_COOLDOWN_MS) {
      const minutesLeft = Math.ceil((BOT_DUEL_COOLDOWN_MS - (now - lastBotDuel)) / 60000);
      const botCdMin = Math.round(BOT_DUEL_COOLDOWN_MS / 60000);
      return {
        response: `@${challengerUsername}, с ботом можно дуэлиться не чаще раз в ${botCdMin} мин. Подожди ещё ${minutesLeft} мин.`
      };
    }
  }

  // Создаём новый вызов
  const challenges = getChallengesForChannel(channel);
  const challengeId = `${challengerNormalized}_${targetNormalized}`;
  
  console.log(`📝 Создание вызова в канале ${channel}:`);
  console.log(`   challengeId: ${challengeId}`);
  console.log(`   challenger: ${challengerNormalized} (display: ${challengerUsername})`);
  console.log(`   challenged: ${targetNormalized} (display: ${targetUsername})`);
  console.log(`   Текущее кол-во вызовов в канале: ${challenges.size}`);
  
  challenges.set(challengeId, {
    challenger: challengerNormalized,
    challengerDisplay: challengerUsername,
    challenged: targetNormalized,
    challengedDisplay: targetUsername,
    createdAt: now
  });

  console.log(`⚔️ Создан персональный вызов #${challenges.size}: ${challengerUsername} -> ${cleanTarget} в канале ${channel}`);

  await storage.saveTwitchPlayers(players);

  // Персональный вызов бота: КД канала и вызывающего уже проверены выше; дальше — как !принять (личный КД/таймаут бота и т.д.)
  if (duelResponderLogin && targetNormalized === duelResponderLogin) {
    console.log(`🤖 Авто-принятие дуэли ботом (${duelResponderLogin})`);
    return await acceptDuelChallenge(cleanTarget, channel);
  }

  return {
    response: `@${challengerUsername} вызывает @${cleanTarget} на дуэль! ⚔️ У @${cleanTarget} есть 2 минуты, чтобы написать !принять или !отклонить`
  };
}

/**
 * Выполнение дуэли между двумя игроками
 */
async function executeDuel(
  player1Username: string,
  player1Normalized: string,
  player2Username: string,
  player2Normalized: string,
  channel: string,
  players: Map<string, TwitchPlayerData>,
  now: number
): Promise<DuelCommandResult> {
  const player1 = ensurePlayer(players, player1Username);
  const player2 = ensurePlayer(players, player2Username);

  const todayStr = new Date().toISOString().slice(0, 10);

  /** Учитывает только победы за день для дейлика (не подряд). */
  function handleDailyProgress(winner: TwitchPlayerData): number {
    if (winner.lastDuelDate !== todayStr) {
      winner.lastDuelDate = todayStr;
      winner.duelsToday = 0;
      winner.lastDailyQuestRewardDate = undefined;
    }

    winner.duelsToday = (winner.duelsToday ?? 0) + 1;

    if (
      winner.duelsToday >= dailyQuestConfig.dailyGamesCount &&
      winner.lastDailyQuestRewardDate !== todayStr
    ) {
      winner.lastDailyQuestRewardDate = todayStr;
      winner.points = (winner.points ?? DEFAULT_POINTS) + dailyQuestConfig.dailyRewardPoints;
      return dailyQuestConfig.dailyRewardPoints;
    }

    return 0;
  }

  function handleStreakOnOutcome(
    winner: TwitchPlayerData | null,
    loser: TwitchPlayerData | null,
    isDraw: boolean
  ): { winnerBonus: number } {
    if (isDraw) {
      if (winner) {
        winner.duelWinStreak = 0;
        winner.streakRewardActive = false;
      }
      if (loser) {
        loser.duelWinStreak = 0;
        loser.streakRewardActive = false;
      }
      return { winnerBonus: 0 };
    }

    if (winner) {
      winner.duelWinStreak = (winner.duelWinStreak ?? 0) + 1;
      let added = 0;
      if (
        winner.duelWinStreak >= dailyQuestConfig.streakWinsCount &&
        !winner.streakRewardActive
      ) {
        winner.streakRewardActive = true;
        winner.points = (winner.points ?? DEFAULT_POINTS) + dailyQuestConfig.streakRewardPoints;
        added = dailyQuestConfig.streakRewardPoints;
      }

      if (loser) {
        loser.duelWinStreak = 0;
        loser.streakRewardActive = false;
      }

      return { winnerBonus: added };
    }

    return { winnerBonus: 0 };
  }
  
  const player1IsExempt = DUEL_EXEMPT_USERS.has(player1Normalized);
  const player2IsExempt = DUEL_EXEMPT_USERS.has(player2Normalized);
  
  // Специальные исходы дуэли (только если оба не exempt)
  const randomValue = Math.random();
  
  // 5% шанс - оба попали и убили друг друга
  const bothHit = !player1IsExempt && !player2IsExempt && randomValue < 0.05;
  
  // 5% шанс - оба промахнулись
  const bothMiss = !player1IsExempt && !player2IsExempt && randomValue >= 0.05 && randomValue < 0.1;

  if (bothHit) {
    // ничья — победы нет, дейлик не считаем
    handleStreakOnOutcome(player1, player2, true);

    player1.points = Math.max(0, (player1.points ?? DEFAULT_POINTS) - duelConfig.lossPoints);
    player2.points = Math.max(0, (player2.points ?? DEFAULT_POINTS) - duelConfig.lossPoints);
    player1.duelTimeoutUntil = now + getDuelTimeoutMs();
    player2.duelTimeoutUntil = now + getDuelTimeoutMs();

    player1.duelLosses = (player1.duelLosses ?? 0) + 1;
    player2.duelLosses = (player2.duelLosses ?? 0) + 1;

    if (!duelCooldownSkipped) duelCooldownByChannel.set(channel, now);
    
    // КРИТИЧНО: Очищаем ВСЕ вызовы в канале, т.к. включился cooldown на 1 минуту
    clearAllChallengesInChannel(channel, 'Оба убили друг друга, cooldown 1 мин');
    
    await storage.saveTwitchPlayers(players);
    onDuelBannedListChanged?.();

    markBotDuelParticipationCooldown(channel, player1Normalized, player2Normalized, now);

    const introMessage = `@${player1Username} и @${player2Username} сошлись в дуэли!`;
    const finalMessage = `Оба попали и убили друг друга! 💀💀 Оба получают (-${duelConfig.lossPoints}) очков и таймаут на ${duelConfig.timeoutMinutes} мин.`;

    if (duelOverlaySyncEnabled) {
      const postOverlayMessage = (async (): Promise<string | undefined> => {
        const sent = await sendOverlayDuelSafe(player1Username, player2Username, 'all-lose');
        if (!sent) {
          return finalMessage;
        }
        const waitFromSec = Math.floor(Date.now() / 1000);
        await waitOverlayDuelCompleteEvent(waitFromSec);
        return finalMessage;
      })();

      return {
        response: introMessage,
        loser: player1Username,
        loser2: player2Username,
        bothLost: true,
        postOverlayMessage,
      };
    }

    void sendOverlayDuel(player1Username, player2Username, 'all-lose');

    return {
      response: `${introMessage} ${finalMessage}`,
      loser: player1Username,
      loser2: player2Username,
      bothLost: true
    };
  }

  if (bothMiss) {
    // ничья — победы нет, дейлик не считаем
    handleStreakOnOutcome(player1, player2, true);
    player1.points = Math.max(0, (player1.points ?? DEFAULT_POINTS) - duelConfig.missPenalty);
    player2.points = Math.max(0, (player2.points ?? DEFAULT_POINTS) - duelConfig.missPenalty);

    // Оба промахнулись - ничья, даём обоим КД на 1 минуту (если не отключён для тестов)
    if (!duelCooldownSkipped) {
      if (!player1IsExempt) player1.duelCooldownUntil = now + DUEL_PLAYER_COOLDOWN_MS;
      if (!player2IsExempt) player2.duelCooldownUntil = now + DUEL_PLAYER_COOLDOWN_MS;
    }
    player1.duelDraws = (player1.duelDraws ?? 0) + 1;
    player2.duelDraws = (player2.duelDraws ?? 0) + 1;

    if (!duelCooldownSkipped) duelCooldownByChannel.set(channel, now);
    
    // КРИТИЧНО: Очищаем ВСЕ вызовы в канале, т.к. включился cooldown на 1 минуту
    clearAllChallengesInChannel(channel, 'Оба промахнулись, cooldown 1 мин');
    
    await storage.saveTwitchPlayers(players);

    markBotDuelParticipationCooldown(channel, player1Normalized, player2Normalized, now);

    const introMessage = `@${player1Username} и @${player2Username} сошлись в дуэли!`;
    const finalMessage = `Оба промахнулись! 😅 Живы оба, но позор на всю деревню! (-${duelConfig.missPenalty}) очков каждому.`;

    if (duelOverlaySyncEnabled) {
      const postOverlayMessage = (async (): Promise<string | undefined> => {
        const sent = await sendOverlayDuelSafe(player1Username, player2Username, 'all-win');
        if (!sent) {
          return finalMessage;
        }
        const waitFromSec = Math.floor(Date.now() / 1000);
        await waitOverlayDuelCompleteEvent(waitFromSec);
        return finalMessage;
      })();

      return {
        response: introMessage,
        loser: undefined,
        loser2: undefined,
        bothLost: false,
        postOverlayMessage,
      };
    }

    // Сообщаем о результате дуэли в Overlay (оба выжили / ничья)
    void sendOverlayDuel(player1Username, player2Username, 'all-win');

    return {
      response: `${introMessage} ${finalMessage}`,
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
  let winnerDailyBonus = 0;
  let winnerStreakBonus = 0;

  if (player1Wins) {
    const dailyBonus1 = handleDailyProgress(player1); // только победитель — победы за день
    const dailyBonus2 = 0;
    const { winnerBonus } = handleStreakOnOutcome(player1, player2, false);
    winnerDailyBonus = dailyBonus1;
    winnerStreakBonus = winnerBonus;

    player1.points = (player1.points ?? DEFAULT_POINTS) + duelConfig.winPoints;
    player2.points = Math.max(0, (player2.points ?? DEFAULT_POINTS) - duelConfig.lossPoints);
    // Проигравший: таймаут из конфига
    if (!player2IsExempt) {
      player2.duelTimeoutUntil = now + getDuelTimeoutMs();
    }
    // Победитель: 1 минута КД (если не отключён для тестов)
    if (!duelCooldownSkipped && !player1IsExempt) {
      player1.duelCooldownUntil = now + DUEL_PLAYER_COOLDOWN_MS;
    }
    player1.duelWins = (player1.duelWins ?? 0) + 1;
    player2.duelLosses = (player2.duelLosses ?? 0) + 1;

    if (dailyBonus1 || dailyBonus2 || winnerBonus) {
      console.log(
        `🎁 Награды дуэли: ${player1Username} +${duelConfig.winPoints + dailyBonus1 + winnerBonus}, ` +
        `${player2Username} -${duelConfig.lossPoints} (+${dailyBonus2})`
      );
    }
  } else {
    const dailyBonus1 = 0;
    const dailyBonus2 = handleDailyProgress(player2); // только победитель — победы за день
    const { winnerBonus } = handleStreakOnOutcome(player2, player1, false);
    winnerDailyBonus = dailyBonus2;
    winnerStreakBonus = winnerBonus;

    player2.points = (player2.points ?? DEFAULT_POINTS) + duelConfig.winPoints;
    player1.points = Math.max(0, (player1.points ?? DEFAULT_POINTS) - duelConfig.lossPoints);
    // Проигравший: таймаут из конфига
    if (!player1IsExempt) {
      player1.duelTimeoutUntil = now + getDuelTimeoutMs();
    }
    // Победитель: 1 минута КД (если не отключён для тестов)
    if (!duelCooldownSkipped && !player2IsExempt) {
      player2.duelCooldownUntil = now + DUEL_PLAYER_COOLDOWN_MS;
    }
    player2.duelWins = (player2.duelWins ?? 0) + 1;
    player1.duelLosses = (player1.duelLosses ?? 0) + 1;

    if (dailyBonus1 || dailyBonus2 || winnerBonus) {
      console.log(
        `🎁 Награды дуэли: ${player2Username} +${duelConfig.winPoints + dailyBonus2 + winnerBonus}, ` +
        `${player1Username} -${duelConfig.lossPoints} (+${dailyBonus1})`
      );
    }
  }

  if (!duelCooldownSkipped) duelCooldownByChannel.set(channel, now);
  
  // КРИТИЧНО: Очищаем ВСЕ вызовы в канале, т.к. включился cooldown на 1 минуту
  clearAllChallengesInChannel(channel, `Дуэль ${winner} vs ${loser}, cooldown 1 мин`);
  
  await storage.saveTwitchPlayers(players);
  onDuelBannedListChanged?.();

  // Сообщаем о результате дуэли в Overlay
  const mode: DuelMode = winner === player1Username ? 'a-win' : 'b-win';

  const extraMessages: string[] = [];
  if (winnerDailyBonus > 0) {
    extraMessages.push(
      `@${winner} получил ежедневную награду за ${dailyQuestConfig.dailyGamesCount} побед: +${dailyQuestConfig.dailyRewardPoints} очков! 🎁`
    );
  }
  if (winnerStreakBonus > 0) {
    extraMessages.push(
      `@${winner} получил награду за серию из ${dailyQuestConfig.streakWinsCount} побед подряд: +${dailyQuestConfig.streakRewardPoints} очков! 🔥`
    );
  }

  markBotDuelParticipationCooldown(channel, player1Normalized, player2Normalized, now);

  const introMessage = `@${player1Username} и @${player2Username} сошлись в дуэли!`;
  const finalMessage = `Победитель @${winner} (+${duelConfig.winPoints}), проигравший @${loser} (-${duelConfig.lossPoints}) и в таймаут на ${duelConfig.timeoutMinutes} мин.`;

  if (duelOverlaySyncEnabled) {
    const postOverlayMessage = (async (): Promise<string | undefined> => {
      const sent = await sendOverlayDuelSafe(player1Username, player2Username, mode);
      if (!sent) {
        return finalMessage;
      }
      const waitFromSec = Math.floor(Date.now() / 1000);
      await waitOverlayDuelCompleteEvent(waitFromSec);
      return finalMessage;
    })();

    return {
      response: introMessage,
      loser,
      postOverlayMessage,
      ...(extraMessages.length > 0 && { extraMessages })
    };
  }

  void sendOverlayDuel(player1Username, player2Username, mode);

  return {
    response: `${introMessage} ${finalMessage}`,
    loser,
    ...(extraMessages.length > 0 && { extraMessages })
  };
}

export async function processTwitchDuelCommand(
    twitchUsername: string,
    channel: string,
    targetUsername?: string
): Promise<DuelCommandResult> {
  await ensureDuelOverlaySyncLoadedFromDb();

  // Проверяем, включены ли дуэли
  if (!duelsEnabled) {
    return {
      response: '' // Игнорируем команду, ничего не отвечаем
    };
  }

  const players = await storage.loadTwitchPlayers();
  const now = Date.now();
  const normalized = twitchUsername.toLowerCase();
  const player = ensurePlayer(players, twitchUsername);

  // Если указан целевой пользователь - это персональный вызов
  if (targetUsername) {
    return await handlePersonalChallenge(twitchUsername, normalized, targetUsername, channel, players, now);
  }

  // Очищаем устаревшие вызовы
  cleanExpiredChallenges(channel, now);

  // Проверяем exempt от cooldown
  const isExempt = DUEL_EXEMPT_USERS.has(normalized);

  // Проверяем кто в очереди (чтобы решить, нужен ли cooldown check)
  const waiting = duelQueueByChannel.get(channel);
  const waitingIsExempt = waiting ? DUEL_EXEMPT_USERS.has(waiting.username) : false;

  // Проверяем глобальный cooldown дуэлей (если не отключён для тестов и пользователь не exempt)
  // ИСКЛЮЧЕНИЕ: если в очереди стоит exempt пользователь (стример), пропускаем cooldown
  if (!duelCooldownSkipped && !isExempt && !waitingIsExempt) {
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

  // Проверяем личный cooldown игрока (если не отключён для тестов и пользователь не exempt)
  // ИСКЛЮЧЕНИЕ: если в очереди стоит exempt пользователь (стример), пропускаем cooldown
  if (!duelCooldownSkipped && !isExempt && !waitingIsExempt && player.duelCooldownUntil && now < player.duelCooldownUntil) {
    const secondsLeft = Math.ceil((player.duelCooldownUntil - now) / 1000);
    return {
      response: `@${twitchUsername}, ты недавно участвовал в дуэли, жди ${secondsLeft} сек.`
    };
  }

  // Проверяем, что игрок не участвует в персональном вызове
  const userChallenge = findUserChallenge(channel, normalized);
  if (userChallenge) {
    if (userChallenge.challenger === normalized) {
      return {
        response: `@${twitchUsername}, ты уже вызвал @${userChallenge.challengedDisplay} на дуэль! Дождись ответа.`
      };
    } else {
      return {
        response: `@${twitchUsername}, тебя вызвал @${userChallenge.challengerDisplay} на дуэль! Напиши !принять или !отклонить`
      };
    }
  }

  // Проверяем таймаут очереди - если истекла, уведомляем и обновляем
  if (waiting && now - waiting.joinedAt > QUEUE_TIMEOUT_MS) {
    console.log(`⏱️ Очередь дуэли истекла для ${waiting.displayName}, соперник не нашёлся, очередь очищена`);
    duelQueueByChannel.delete(channel);
    // После удаления очередь пуста - ставим нового игрока
    duelQueueByChannel.set(channel, { username: normalized, displayName: twitchUsername, joinedAt: now });
    await storage.saveTwitchPlayers(players);
    return {
      response: `Очередь истекла. @${twitchUsername} встал в очередь на дуэль. Ждём 2 минуты соперника!`
    };
  }

  if (!waiting) {
    duelQueueByChannel.set(channel, { username: normalized, displayName: twitchUsername, joinedAt: now });
    await storage.saveTwitchPlayers(players);
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

  // Проверяем, что игрок из очереди не участвует в персональном вызове
  const waitingUserChallenge = findUserChallenge(channel, waiting.username);
  if (waitingUserChallenge) {
    // Игрок в очереди участвует в персональном вызове - очищаем очередь
    duelQueueByChannel.delete(channel);
    if (waitingUserChallenge.challenger === waiting.username) {
      return {
        response: `@${waiting.displayName} уже вызвал @${waitingUserChallenge.challengedDisplay} на дуэль, очередь отменена. @${twitchUsername}, встань в очередь снова!`
      };
    } else {
      return {
        response: `@${waiting.displayName} вызван @${waitingUserChallenge.challengerDisplay} на персональную дуэль, очередь отменена. @${twitchUsername}, встань в очередь снова!`
      };
    }
  }

  // Удаляем из очереди и выполняем дуэль
  duelQueueByChannel.delete(channel);
  
  return await executeDuel(
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
  const normalized = twitchUsername.toLowerCase();
  return EXTRA_DUEL_ADMINS.has(normalized) || dynamicDuelAdmins.has(normalized);
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
 * Включить дуэли из веб-админки (без проверки прав — доступ уже защищён Nginx Basic Auth)
 */
export function enableDuelsFromWeb(): void {
  duelsEnabled = true;
  console.log('✅ Дуэли включены через веб-интерфейс');
}

/**
 * Выключить дуэли из веб-админки
 */
export function disableDuelsFromWeb(): void {
  duelsEnabled = false;
  console.log('🛑 Дуэли выключены через веб-интерфейс');
}

/**
 * Получить статус дуэлей
 */
export function areDuelsEnabled(): boolean {
  return duelsEnabled;
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
export async function pardonAllDuelTimeouts(twitchUsername: string): Promise<{ success: boolean; count: number; usernames: string[] }> {
  if (!canManageDuels(twitchUsername)) {
    console.log(`⚠️ Пользователь ${twitchUsername} попытался использовать амнистию без прав`);
    return { success: false, count: 0, usernames: [] };
  }
  return pardonAllDuelTimeoutsInternal();
}

/**
 * Амнистия из веб-админки (без проверки прав)
 */
export async function pardonAllDuelTimeoutsFromWeb(): Promise<{ success: boolean; count: number; usernames: string[] }> {
  return pardonAllDuelTimeoutsInternal();
}

async function pardonAllDuelTimeoutsInternal(): Promise<{ success: boolean; count: number; usernames: string[] }> {
  const players = await storage.loadTwitchPlayers();
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
    await storage.saveTwitchPlayers(players);
    onDuelBannedListChanged?.();
    console.log(`🕊️ Амнистия: снято ${pardoned} таймаутов дуэлей`);
    console.log(`📋 Игроки для разбана: ${usernamesWithTimeout.join(', ')}`);
  } else {
    console.log(`ℹ️ Амнистия: нет активных таймаутов для снятия`);
  }

  return { success: true, count: pardoned, usernames: usernamesWithTimeout };
}

/**
 * Список игроков с активным таймаутом дуэли (для веб-админки)
 */
export async function getDuelBannedPlayersFromWeb(): Promise<{ username: string; timeoutUntil: number }[]> {
  const players = await storage.loadTwitchPlayers();
  const now = Date.now();
  const list: { username: string; timeoutUntil: number }[] = [];
  for (const [, player] of players.entries()) {
    if (player.duelTimeoutUntil && player.duelTimeoutUntil > now) {
      list.push({ username: player.twitchUsername, timeoutUntil: player.duelTimeoutUntil });
    }
  }
  list.sort((a, b) => a.timeoutUntil - b.timeoutUntil);
  return list;
}

/**
 * Амнистия для одного игрока (для веб-админки)
 */
export async function pardonDuelUserFromWeb(username: string): Promise<{ success: boolean }> {
  if (!username || !username.trim()) return { success: false };
  const players = await storage.loadTwitchPlayers();
  const normalized = username.trim().toLowerCase();
  const player = players.get(normalized);
  if (!player || !player.duelTimeoutUntil || player.duelTimeoutUntil <= Date.now()) {
    return { success: false };
  }
  delete player.duelTimeoutUntil;
  await storage.saveTwitchPlayers(players);
  onDuelBannedListChanged?.();
  console.log(`🕊️ Амнистия для одного: снят таймаут дуэли с ${player.twitchUsername}`);
  return { success: true };
}

/**
 * Принятие персонального вызова на дуэль
 */
export async function acceptDuelChallenge(
  twitchUsername: string,
  channel: string
): Promise<DuelCommandResult> {
  await ensureDuelOverlaySyncLoadedFromDb();

  if (!duelsEnabled) {
    return {
      response: ''
    };
  }

  const players = await storage.loadTwitchPlayers();
  const now = Date.now();
  const normalized = twitchUsername.toLowerCase();
  
  // Очищаем устаревшие вызовы
  cleanExpiredChallenges(channel, now);

  // Ищем вызов, где этот пользователь - вызванный игрок
  const userChallenge = findUserChallenge(channel, normalized);
  
  if (!userChallenge) {
    return {
      response: `@${twitchUsername}, нет активных вызовов на дуэль`
    };
  }

  // Проверяем, что принимает именно вызванный игрок
  if (userChallenge.challenged !== normalized) {
    return {
      response: `@${twitchUsername}, этот вызов не для тебя! Вызван @${userChallenge.challengedDisplay}`
    };
  }

  const challengedPlayer = ensurePlayer(players, twitchUsername);
  const challengedIsExempt = DUEL_EXEMPT_USERS.has(normalized);
  const challengerIsExempt = DUEL_EXEMPT_USERS.has(userChallenge.challenger);

  // Проверяем личный timeout принимающего (если не exempt)
  if (!challengedIsExempt && challengedPlayer.duelTimeoutUntil && now < challengedPlayer.duelTimeoutUntil) {
    const minutesLeft = Math.ceil((challengedPlayer.duelTimeoutUntil - now) / 60000);
    clearUserChallenges(channel, normalized);
    return {
      response: `@${twitchUsername}, ты в таймауте ещё ${minutesLeft} мин. Вызов отменён.`
    };
  }

  // Проверяем личный cooldown принимающего (если не отключён для тестов и не exempt)
  // ИСКЛЮЧЕНИЕ: если вызвал exempt пользователь (стример), пропускаем cooldown
  if (!duelCooldownSkipped && !challengedIsExempt && !challengerIsExempt && challengedPlayer.duelCooldownUntil && now < challengedPlayer.duelCooldownUntil) {
    const secondsLeft = Math.ceil((challengedPlayer.duelCooldownUntil - now) / 1000);
    clearUserChallenges(channel, normalized);
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
      if (queueEntry.username === userChallenge.challenger) {
        clearUserChallenges(channel, normalized);
        duelQueueByChannel.delete(channel);
        return {
          response: `@${userChallenge.challengerDisplay} уже стоит в очереди на обычную дуэль. Вызов отменён.`
        };
      }
      if (queueEntry.username === userChallenge.challenged) {
        clearUserChallenges(channel, normalized);
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

  console.log(`✅ Вызов принят: ${twitchUsername} принимает вызов от ${userChallenge.challengerDisplay}`);
  
  // Не удаляем вызовы здесь - это сделает executeDuel() после установки cooldown
  // (Очистка происходит через clearAllChallengesInChannel внутри executeDuel)
  
  return await executeDuel(
    userChallenge.challengerDisplay,
    userChallenge.challenger,
    userChallenge.challengedDisplay,
    userChallenge.challenged,
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
  
  // Очищаем устаревшие вызовы
  cleanExpiredChallenges(channel, now);
  
  // Ищем вызов, где этот пользователь - вызванный игрок
  const userChallenge = findUserChallenge(channel, normalized);
  
  if (!userChallenge) {
    return {
      response: `@${twitchUsername}, нет активных вызовов на дуэль`
    };
  }

  // Проверяем, что отклоняет именно вызванный игрок
  if (userChallenge.challenged !== normalized) {
    return {
      response: `@${twitchUsername}, этот вызов не для тебя!`
    };
  }

  // Удаляем вызов
  clearUserChallenges(channel, normalized);
  
  console.log(`🏳️ Вызов отклонён: ${twitchUsername} отклонил вызов от ${userChallenge.challengerDisplay}`);
  
  return {
    response: `@${twitchUsername} отклонил вызов от @${userChallenge.challengerDisplay} 🏳️`
  };
}

/**
 * Включить/выключить двухэтапные сообщения дуэли с ожиданием ответа оверлея
 */
export function enableDuelOverlaySync(twitchUsername: string): boolean {
  if (!canManageDuels(twitchUsername)) {
    return false;
  }
  duelOverlaySyncEnabled = true;
  persistDuelOverlaySyncToDb(true);
  console.log(`✅ Синхронизация дуэлей с оверлеем включена пользователем ${twitchUsername}`);
  return true;
}

export function disableDuelOverlaySync(twitchUsername: string): boolean {
  if (!canManageDuels(twitchUsername)) {
    return false;
  }
  duelOverlaySyncEnabled = false;
  persistDuelOverlaySyncToDb(false);
  console.log(`🛑 Синхронизация дуэлей с оверлеем выключена пользователем ${twitchUsername}`);
  return true;
}

export function isDuelOverlaySyncEnabled(): boolean {
  return duelOverlaySyncEnabled;
}

/**
 * Включить/выключить синхронизацию оверлея из веб-админки
 * (без проверки прав — доступ уже защищён)
 */
export function enableDuelOverlaySyncFromWeb(): void {
  duelOverlaySyncEnabled = true;
  persistDuelOverlaySyncToDb(true);
  console.log('✅ Синхронизация дуэлей с оверлеем включена через веб-интерфейс');
}

export function disableDuelOverlaySyncFromWeb(): void {
  duelOverlaySyncEnabled = false;
  persistDuelOverlaySyncToDb(false);
  console.log('🛑 Синхронизация дуэлей с оверлеем выключена через веб-интерфейс');
}

export async function initDuelOverlaySyncFromDb(): Promise<void> {
  await ensureDuelOverlaySyncLoadedFromDb();
}

/**
 * Очистка персональных вызовов (вызывается при окончании стрима)
 */
export function clearDuelChallenges(): void {
  let challengesCount = 0;
  for (const [_, challenges] of duelChallengesByChannel) {
    challengesCount += challenges.size;
  }
  duelChallengesByChannel.clear();
  if (challengesCount > 0) {
    console.log(`🧹 Персональные вызовы очищены (было ${challengesCount} вызовов)`);
  }
}
