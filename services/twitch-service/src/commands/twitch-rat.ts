// Отслеживаем активных пользователей по каналам (fallback если API недоступен)
// Map<channel, Map<username, lastMessageTimestamp>>
const activeUsersByChannel = new Map<string, Map<string, number>>();
// Отслеживаем кд команд по каналам
const cooldownByChannel = new Map<string, Map<string, number>>();
const COOLDOWN_MS = 60 * 1000; // 1 минута
const INACTIVE_TIMEOUT_MS = 30 * 60 * 1000; // 30 минут - удаляем неактивных

// Исключить из команды !крыса (но оставить в !милашка)
const RAT_EXCLUDED_USERS = new Set(['kunilika666']);

// Пользователи без cooldown (стример)
const COOLDOWN_EXEMPT_USERS = new Set(['kunilika666']);

// Стример для !милашка (попадает каждый 3-й вызов)
const CUTIE_SPECIAL_USER = 'kunilika666';
const CUTIE_SPECIAL_EVERY_N = 3; // каждый 3-й вызов
const cutieCallCountByChannel = new Map<string, number>(); // счётчик по каналам

// Функция для получения списка зрителей через API (инжектится из nightbot-monitor)
let getChattersAPI: ((channel: string) => Promise<string[]>) | null = null;

/**
 * Установить функцию для получения списка зрителей через Twitch API
 * Вызывается из nightbot-monitor после инициализации
 */
export function setChattersAPIFunction(fn: (channel: string) => Promise<string[]>): void {
  getChattersAPI = fn;
  console.log('✅ Установлена функция получения зрителей через API');
}

/**
 * Добавить пользователя в список активных (fallback)
 * Обновляет timestamp последнего сообщения
 */
export function addActiveUser(channel: string, username: string): void {
  const normalized = channel.replace(/^#/, '').toLowerCase();
  if (!activeUsersByChannel.has(normalized)) {
    activeUsersByChannel.set(normalized, new Map());
  }
  activeUsersByChannel.get(normalized)!.set(username.toLowerCase(), Date.now());
}

/**
 * Получить список пользователей для выбора
 * Приоритет: API чаттеров -> fallback на activeUsers
 */
async function getUsersForSelection(channel: string): Promise<string[]> {
  const normalized = channel.replace(/^#/, '').toLowerCase();

  // Пробуем получить через API
  if (getChattersAPI) {
    try {
      const chatters = await getChattersAPI(normalized);
      if (chatters.length > 0) {
        return chatters;
      }
    } catch (error) {
      console.error('⚠️ API чаттеров недоступен, используем fallback:', error);
    }
  }

  // Fallback на activeUsers (с фильтрацией неактивных)
  const activeUsers = activeUsersByChannel.get(normalized);
  if (!activeUsers) {
    return [];
  }

  const now = Date.now();
  const activeList: string[] = [];
  
  // Фильтруем и удаляем неактивных (не писали 30+ минут)
  for (const [username, lastMessageAt] of activeUsers.entries()) {
    if (now - lastMessageAt < INACTIVE_TIMEOUT_MS) {
      activeList.push(username);
    } else {
      activeUsers.delete(username); // Удаляем неактивного
    }
  }

  return activeList;
}

export async function processTwitchRandomUserCommand(
    channel: string,
    type: 'rat' | 'cutie' = 'rat',
    caller?: string
): Promise<{ response: string }> {
  const normalized = channel.replace(/^#/, '').toLowerCase();
  const now = Date.now();
  const callerNormalized = caller?.toLowerCase() || '';
  
  // Проверяем exempt от cooldown
  const isExempt = COOLDOWN_EXEMPT_USERS.has(callerNormalized);
  
  // Проверяем кд (если пользователь не exempt)
  if (!isExempt) {
    if (!cooldownByChannel.has(normalized)) {
      cooldownByChannel.set(normalized, new Map());
    }
    
    const channelCooldowns = cooldownByChannel.get(normalized)!;
    const lastCommandAt = channelCooldowns.get(type);
    
    if (lastCommandAt && now - lastCommandAt < COOLDOWN_MS) {
      const secondsLeft = Math.ceil((COOLDOWN_MS - (now - lastCommandAt)) / 1000);
      const cooldownMessage = type === "rat"
        ? `Крысу уже ловили, жди ${secondsLeft} сек.`
        : `Милашку уже выбрали, жди ${secondsLeft} сек.`;
      return {
        response: cooldownMessage
      };
    }
  }

  // Получаем список пользователей (API или fallback)
  let usersArray = await getUsersForSelection(channel);

  // Для !крыса исключаем определённых пользователей
  if (type === 'rat') {
    usersArray = usersArray.filter(user => !RAT_EXCLUDED_USERS.has(user.toLowerCase()));
  }

  if (usersArray.length === 0) {
    return {
      response: type === "rat"
        ? `Крыс не обнаружено! Напишите что-нибудь в чат.`
        : `Милашек не найдено! Напишите что-нибудь в чат.`
    };
  }

  // Выбираем пользователя
  let randomUser: string;
  
  // Для !милашка: каждый 3-й вызов выдаёт стримера
  if (type === 'cutie') {
    const count = (cutieCallCountByChannel.get(normalized) || 0) + 1;
    cutieCallCountByChannel.set(normalized, count);
    
    if (count % CUTIE_SPECIAL_EVERY_N === 0) {
      randomUser = CUTIE_SPECIAL_USER;
    } else {
      randomUser = usersArray[Math.floor(Math.random() * usersArray.length)];
    }
  } else {
    randomUser = usersArray[Math.floor(Math.random() * usersArray.length)];
  }

  // Устанавливаем кд (если пользователь не exempt)
  if (!isExempt) {
    if (!cooldownByChannel.has(normalized)) {
      cooldownByChannel.set(normalized, new Map());
    }
    const channelCooldowns = cooldownByChannel.get(normalized)!;
    channelCooldowns.set(type, now);
  }

  const resultMessage = type === "rat"
    ? `КРЫСА ОБНАРУЖЕНА: @${randomUser}!`
    : `Сегодня милашка чата @${randomUser}!`;

  return {
    response: resultMessage
  };
}

// Асинхронные версии для использования в nightbot-monitor
export async function processTwitchRatCommand(channel: string, caller?: string): Promise<{ response: string }> {
  return processTwitchRandomUserCommand(channel, 'rat', caller);
}

export async function processTwitchCutieCommand(channel: string, caller?: string): Promise<{ response: string }> {
  return processTwitchRandomUserCommand(channel, 'cutie', caller);
}

/**
 * Очистить активных пользователей канала (вызывается при окончании стрима)
 * Также сбрасывает cooldown и счётчик милашки
 */
export function clearActiveUsers(channel: string): void {
  const normalized = channel.replace(/^#/, '').toLowerCase();
  activeUsersByChannel.delete(normalized);
  cooldownByChannel.delete(normalized);
  cutieCallCountByChannel.delete(normalized);
  console.log(`🧹 Активные пользователи, кд и счётчики канала ${channel} очищены`);
}

/**
 * Очистить всех активных пользователей
 */
export function clearAllActiveUsers(): void {
  activeUsersByChannel.clear();
  cooldownByChannel.clear();
  cutieCallCountByChannel.clear();
  console.log(`🧹 Все активные пользователи, кды и счётчики очищены`);
}

/**
 * Очистка неактивных пользователей (GC)
 * Удаляет пользователей, которые не писали более INACTIVE_TIMEOUT_MS
 */
function cleanupInactiveUsers(): void {
  const now = Date.now();
  let totalRemoved = 0;

  for (const [channel, users] of activeUsersByChannel.entries()) {
    for (const [username, lastMessageAt] of users.entries()) {
      if (now - lastMessageAt >= INACTIVE_TIMEOUT_MS) {
        users.delete(username);
        totalRemoved++;
      }
    }
  }

  if (totalRemoved > 0) {
    console.log(`🧹 GC: удалено ${totalRemoved} неактивных пользователей`);
  }
}

// Запускаем периодическую очистку каждые 5 минут
setInterval(cleanupInactiveUsers, 5 * 60 * 1000);
