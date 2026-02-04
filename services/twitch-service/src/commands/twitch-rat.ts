// Отслеживаем активных пользователей по каналам
const activeUsersByChannel = new Map<string, Set<string>>();
// Отслеживаем кулдаун команды !крыса по каналам
const ratCooldownByChannel = new Map<string, number>();
const RAT_COOLDOWN_MS = 60 * 1000; // 1 минута

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

export function processTwitchRatCommand(
    channel: string
): { response: string } {
  const normalized = channel.toLowerCase();
  const now = Date.now();
  
  // Проверяем кулдаун
  const lastRatAt = ratCooldownByChannel.get(normalized);
  if (lastRatAt && now - lastRatAt < RAT_COOLDOWN_MS) {
    const secondsLeft = Math.ceil((RAT_COOLDOWN_MS - (now - lastRatAt)) / 1000);
    return {
      response: `Крысу уже ловили, жди ${secondsLeft} сек.`
    };
  }

  const activeUsers = activeUsersByChannel.get(normalized);

  // Конвертируем Set в Array и выбираем рандомного
  const usersArray = Array.from(activeUsers || []);
  const randomRat = usersArray[Math.floor(Math.random() * usersArray.length)];

  // Устанавливаем кулдаун
  ratCooldownByChannel.set(normalized, now);

  return {
    response: `КРЫСА ОБНАРУЖЕНА: @${randomRat}!`
  };
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
  ratCooldownByChannel.clear();
  console.log(`🧹 Все активные пользователи и кулдауны очищены`);
}
