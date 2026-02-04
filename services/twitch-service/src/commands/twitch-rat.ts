// Отслеживаем активных пользователей по каналам
const activeUsersByChannel = new Map<string, Set<string>>();
// Отслеживаем кд команд по каналам
const cooldownByChannel = new Map<string, Map<string, number>>();
const COOLDOWN_MS = 60 * 1000; // 1 минута

/**
 * Добавить пользователя в список активных
 */
export function addActiveUser(channel: string, username: string): void {
  const normalized = channel.toLowerCase();
  if (!activeUsersByChannel.has(normalized)) {
    activeUsersByChannel.set(normalized, new Set());
  }
  activeUsersByChannel.get(normalized)!.add(username.toLowerCase());
}

export function processTwitchRandomUserCommand(
    channel: string,
    type: 'rat' | 'cutie' = 'rat'
): { response: string } {
  const normalized = channel.toLowerCase();
  const now = Date.now();
  
  // Инициализируем Map кд для канала, если не существует
  if (!cooldownByChannel.has(normalized)) {
    cooldownByChannel.set(normalized, new Map());
  }
  
  const channelCooldowns = cooldownByChannel.get(normalized)!;
  const lastCommandAt = channelCooldowns.get(type);
  
  // Проверяем кд
  if (lastCommandAt && now - lastCommandAt < COOLDOWN_MS) {
    const secondsLeft = Math.ceil((COOLDOWN_MS - (now - lastCommandAt)) / 1000);
    const cooldownMessage = type === "rat"
      ? `Крысу уже ловили, жди ${secondsLeft} сек.`
      : `Милашку уже выбрали, жди ${secondsLeft} сек.`;
    return {
      response: cooldownMessage
    };
  }

  const activeUsers = activeUsersByChannel.get(normalized);

  // Конвертируем Set в Array и выбираем рандомного
  const usersArray = Array.from(activeUsers || []);
  const randomUser = usersArray[Math.floor(Math.random() * usersArray.length)];

  // Устанавливаем кд
  channelCooldowns.set(type, now);

  const resultMessage = type === "rat"
    ? `КРЫСА ОБНАРУЖЕНА: @${randomUser}!`
    : `Сегодня милашка чата @${randomUser}!`;

  return {
    response: resultMessage
  };
}

// Обратная совместимость
export function processTwitchRatCommand(channel: string): { response: string } {
  return processTwitchRandomUserCommand(channel, 'rat');
}

export function processTwitchCutieCommand(channel: string): { response: string } {
  return processTwitchRandomUserCommand(channel, 'cutie');
}

/**
 * Очистить активных пользователей канала (вызывается при окончании стрима)
 */
export function clearActiveUsers(channel: string): void {
  const normalized = channel.toLowerCase();
  activeUsersByChannel.delete(normalized);
  console.log(`🧹 Активные пользователи канала ${channel} очищены`);
}

/**
 * Очистить всех активных пользователей
 */
export function clearAllActiveUsers(): void {
  activeUsersByChannel.clear();
  cooldownByChannel.clear();
  console.log(`🧹 Все активные пользователи и кды очищены`);
}
