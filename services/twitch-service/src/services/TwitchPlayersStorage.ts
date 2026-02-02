import * as fs from 'fs';
import * as path from 'path';

export interface TwitchPlayer {
  userId: string;
  username: string;
  size: number;
  lastUsed: number;
  lastUsedDate: string;
}

/**
 * Сервис для работы с Twitch игроками
 */
export class TwitchPlayersStorage {
  private players: Map<string, TwitchPlayer> = new Map();
  private readonly filePath: string;

  constructor(filePath: string = path.join(process.cwd(), 'twitch-players.json')) {
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
        this.players = new Map(Object.entries(parsed));
      }
    } catch (error) {
      console.error('❌ Ошибка загрузки Twitch игроков:', error);
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
      console.error('❌ Ошибка сохранения Twitch игроков:', error);
    }
  }

  /**
   * Получить всех игроков
   */
  getAll(): Map<string, TwitchPlayer> {
    return new Map(this.players);
  }

  /**
   * Получить игрока по ID
   */
  get(userId: string): TwitchPlayer | undefined {
    return this.players.get(userId);
  }

  /**
   * Сохранить игрока
   */
  set(userId: string, player: TwitchPlayer): void {
    this.players.set(userId, player);
    this.save();
  }

  /**
   * Получить топ игроков
   */
  getTop(limit: number = 10): TwitchPlayer[] {
    return Array.from(this.players.values())
      .sort((a, b) => b.size - a.size)
      .slice(0, limit);
  }

  /**
   * Получить аутсайдеров
   */
  getBottom(limit: number = 10): TwitchPlayer[] {
    return Array.from(this.players.values())
      .sort((a, b) => a.size - b.size)
      .slice(0, limit);
  }
}
