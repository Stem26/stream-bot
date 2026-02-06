import * as fs from 'fs';
import * as path from 'path';

export interface Player {
  userId: number;
  username: string;
  firstName: string;
  size: number;
  lastUsed: number;
  lastUsedDate: string;
  lastHornyDate?: string;
  lastFurryDate?: string;
  lastFutureDate?: string;
  futureAttemptsToday?: number;
  lastGrowth?: number; // Последний прирост для механики компенсации
}

/**
 * Сервис для работы с игроками
 */
export class PlayersStorage {
  private players: Map<number, Player> = new Map();
  private readonly filePath: string;

  constructor(filePath: string = path.join(process.cwd(), 'players.json')) {
    this.filePath = filePath;
    this.load();
  }

  /**
   * Загрузить игроков из файла
   */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(data);
        this.players = new Map(Object.entries(parsed).map(([key, value]) => [parseInt(key), value as Player]));
      }
    } catch (error) {
      console.error('❌ Ошибка загрузки игроков:', error);
      this.players = new Map();
    }
  }

  /**
   * Сохранить игроков в файл
   */
  private save(): void {
    try {
      const obj = Object.fromEntries(this.players);
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (error) {
      console.error('❌ Ошибка сохранения игроков:', error);
    }
  }

  /**
   * Получить всех игроков
   */
  getAll(): Map<number, Player> {
    return new Map(this.players);
  }

  /**
   * Получить игрока по ID
   */
  get(userId: number): Player | undefined {
    return this.players.get(userId);
  }

  /**
   * Сохранить игрока
   */
  set(userId: number, player: Player): void {
    this.players.set(userId, player);
    this.save();
  }

  /**
   * Получить ранг игрока
   */
  getRank(userId: number): number {
    const sorted = Array.from(this.players.values()).sort((a, b) => b.size - a.size);
    return sorted.findIndex(p => p.userId === userId) + 1;
  }

  /**
   * Получить топ игроков
   */
  getTop(limit: number = 10): Player[] {
    return Array.from(this.players.values())
      .sort((a, b) => b.size - a.size)
      .slice(0, limit);
  }

  /**
   * Получить аутсайдеров
   */
  getBottom(limit: number = 10): Player[] {
    return Array.from(this.players.values())
      .sort((a, b) => a.size - b.size)
      .slice(0, limit);
  }
}
