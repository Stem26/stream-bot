import { Player, PlayersStorageDB } from '../../services/PlayersStorageDB';
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

  constructor(private playersStorage: PlayersStorageDB, streamerUserId?: number) {
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
      if (growth < -5) {
        growth = Math.floor(growth / 2);
        console.log(`🛡️ Защита стримера: минус смягчён с ${growth * 2} до ${growth}`);
      }
      if (player && player.lastGrowth && player.lastGrowth < 0) {
        if (Math.random() < 0.5) {
          const bonus = Math.floor(Math.random() * 3) + 1;
          growth += bonus;
          console.log(`🎁 Компенсация стримеру после неудачи: +${bonus} (было ${growth - bonus}, стало ${growth})`);
        }
      }
    }

    return growth;
  }

  private formatGrowthText(growth: number): string {
    if (growth > 0) return `вырос на ${growth}`;
    if (growth < 0) return `уменьшился на ${Math.abs(growth)}`;
    return `не изменился`;
  }

  /**
   * Играть в dick (главная бизнес-логика)
   */
  async play(userId: number, username: string, firstName: string): Promise<DickPlayResult> {
    const today = getMoscowDate();
    const now = Date.now();

    let player = await this.playersStorage.get(userId);
    const isFirstTime = !player;
    const canPlay = !player || canPlayToday(player);

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
      await this.playersStorage.set(userId, player);

      const growthText = this.formatGrowthText(growth);
      const message =
        `@${username}, твой писюн ${growthText} см.\n` +
        `Теперь он равен ${player.size} см.\n` +
        `Следующая попытка завтра!`;

      return { type: 'first_time', player, growth, message };
    }

    if (canPlay && player) {
      const growth = this.calculateGrowth(userId, player);
      player.size += growth;
      player.lastUsed = now;
      player.lastUsedDate = today;
      player.username = username;
      player.firstName = firstName;
      player.lastGrowth = growth;
      await this.playersStorage.set(userId, player);

      const growthText = this.formatGrowthText(growth);
      const message =
        `@${username}, твой писюн ${growthText} см.\n` +
        `Теперь он равен ${player.size} см.\n` +
        `Следующая попытка завтра!`;

      return { type: 'success', player, growth, message };
    }

    if (player) {
      const rank = await this.playersStorage.getRank(userId);
      const message =
        `@${username}, ты уже играл.\n` +
        `Сейчас он равен ${player.size} см.\n` +
        `Ты занимаешь ${rank} место в топе.\n` +
        `Следующая попытка завтра!`;

      return { type: 'already_played', player, rank, message };
    }

    throw new Error('Unexpected state in DickService.play');
  }

  async getTop(limit: number = 10): Promise<Player[]> {
    return this.playersStorage.getTop(limit);
  }

  async getBottom(limit: number = 10): Promise<Player[]> {
    return this.playersStorage.getBottom(limit);
  }

  async getRank(userId: number): Promise<number> {
    return this.playersStorage.getRank(userId);
  }
}
