import { Player, PlayersStorage } from '../../services/PlayersStorage';
import { getMoscowDate, canPlayToday } from '../../utils/date';

/**
 * Результат игры
 */
export interface DickPlayResult {
  type: 'first_time' | 'success' | 'already_played';
  player: Player;
  growth?: number;
  rank?: number;
  message: string;
}

/**
 * Сервис бизнес-логики для игры Dick
 * Примечание: Этот сервис не используется на Twitch, там используется twitch-dick.ts
 */
export class DickService {
  constructor(private playersStorage: PlayersStorage) {}

  /**
   * Рассчитать случайный рост (-10 до +10)
   */
  private calculateGrowth(): number {
    return Math.floor(Math.random() * 21) - 10;
  }

  /**
   * Форматировать текст изменения размера
   */
  private formatGrowthText(growth: number): string {
    if (growth > 0) return `вырос на ${growth}`;
    if (growth < 0) return `уменьшился на ${Math.abs(growth)}`;
    return `не изменился`;
  }

  private formatPlayMessage(username: string, growth: number, size: number): string {
    if (growth === 0) {
      return `@${username}, твой писюн не изменился и теперь равен ${size} см.`;
    }
    return `@${username}, твой писюн ${this.formatGrowthText(growth)} см и теперь равен ${size} см.`;
  }

  /**
   * Играть в dick (главная бизнес-логика)
   */
  play(userId: number, username: string, firstName: string): DickPlayResult {
    const today = getMoscowDate();
    const now = Date.now();

    let player = this.playersStorage.get(userId);
    const isFirstTime = !player;
    const canPlay = !player || canPlayToday(player);

    // ===== Первая игра =====
    if (isFirstTime) {
      const growth = this.calculateGrowth();
      player = {
        userId,
        username,
        firstName,
        size: growth,
        lastUsed: now,
        lastUsedDate: today
      };
      this.playersStorage.set(userId, player);

      return { type: 'first_time', player, growth, message: this.formatPlayMessage(username, growth, player.size) };
    }

    // ===== Можно играть =====
    if (canPlay && player) {
      const growth = this.calculateGrowth();
      player.size += growth;
      player.lastUsed = now;
      player.lastUsedDate = today;
      player.username = username;
      player.firstName = firstName;
      this.playersStorage.set(userId, player);

      return { type: 'success', player, growth, message: this.formatPlayMessage(username, growth, player.size) };
    }

    // ===== Уже играл сегодня =====
    if (player) {
      const rank = this.playersStorage.getRank(userId);
      const message = 
        `@${username}, ты уже играл.\n` +
        `Сейчас он равен ${player.size} см., на ${rank} месте в топе.\n` +
        `Следующая попытка завтра!`;

      return { type: 'already_played', player, rank, message };
    }

    // Не должно сюда попасть, но на всякий случай
    throw new Error('Unexpected state in DickService.play');
  }

  /**
   * Получить топ игроков
   */
  getTop(limit: number = 10): Player[] {
    return this.playersStorage.getTop(limit);
  }

  /**
   * Получить аутсайдеров
   */
  getBottom(limit: number = 10): Player[] {
    return this.playersStorage.getBottom(limit);
  }

  /**
   * Получить ранг игрока
   */
  getRank(userId: number): number {
    return this.playersStorage.getRank(userId);
  }
}
