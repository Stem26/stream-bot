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
 */
export class DickService {
  private streamerUserId?: number;

  constructor(private playersStorage: PlayersStorage, streamerUserId?: number) {
    this.streamerUserId = streamerUserId;
  }

  /**
   * Рассчитать случайный рост (-10 до +10) с учётом защиты для стримера
   */
  private calculateGrowth(userId: number, player?: Player): number {
    let growth = Math.floor(Math.random() * 21) - 10;
    const isStreamer = this.streamerUserId && userId === this.streamerUserId;

    // Защита для стримера
    if (isStreamer) {
      // Вариант 2: Защита от жёсткого минуса
      if (growth < -5) {
        growth = Math.floor(growth / 2);
        console.log(`🛡️ Защита стримера: минус смягчён с ${growth * 2} до ${growth}`);
      }

      // Вариант 3: Компенсация после неудачи
      if (player && player.lastGrowth && player.lastGrowth < 0) {
        if (Math.random() < 0.5) {
          const bonus = Math.floor(Math.random() * 3) + 1; // +1..+3
          growth += bonus;
          console.log(`🎁 Компенсация стримеру после неудачи: +${bonus} (было ${growth - bonus}, стало ${growth})`);
        }
      }
    }

    return growth;
  }

  /**
   * Форматировать текст изменения размера
   */
  private formatGrowthText(growth: number): string {
    if (growth > 0) return `вырос на ${growth}`;
    if (growth < 0) return `уменьшился на ${Math.abs(growth)}`;
    return `не изменился`;
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
      const growth = this.calculateGrowth(userId);
      player = {
        userId,
        username,
        firstName,
        size: growth,
        lastUsed: now,
        lastUsedDate: today,
        lastGrowth: growth
      };
      this.playersStorage.set(userId, player);

      const growthText = this.formatGrowthText(growth);
      const message = 
        `@${username}, твой писюн ${growthText} см.\n` +
        `Теперь он равен ${player.size} см.\n` +
        `Следующая попытка завтра!`;

      return { type: 'first_time', player, growth, message };
    }

    // ===== Можно играть =====
    if (canPlay && player) {
      const growth = this.calculateGrowth(userId, player);
      player.size += growth;
      player.lastUsed = now;
      player.lastUsedDate = today;
      player.username = username;
      player.firstName = firstName;
      player.lastGrowth = growth;
      this.playersStorage.set(userId, player);

      const growthText = this.formatGrowthText(growth);
      const message = 
        `@${username}, твой писюн ${growthText} см.\n` +
        `Теперь он равен ${player.size} см.\n` +
        `Следующая попытка завтра!`;

      return { type: 'success', player, growth, message };
    }

    // ===== Уже играл сегодня =====
    if (player) {
      const rank = this.playersStorage.getRank(userId);
      const message = 
        `@${username}, ты уже играл.\n` +
        `Сейчас он равен ${player.size} см.\n` +
        `Ты занимаешь ${rank} место в топе.\n` +
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
