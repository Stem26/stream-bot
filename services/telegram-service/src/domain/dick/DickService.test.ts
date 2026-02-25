import { describe, it, expect, beforeEach } from 'vitest';
import { DickService } from './DickService';
import { Player, PlayersStorageDB } from '../../services/PlayersStorageDB';
import { getMoscowDate } from '../../utils/date';

/** In-memory mock для тестов DickService */
class MockPlayersStorageDB implements PlayersStorageDB {
  private map = new Map<number, Player>();

  async get(userId: number): Promise<Player | undefined> {
    return this.map.get(userId);
  }

  async set(userId: number, player: Player): Promise<void> {
    this.map.set(userId, { ...player });
  }

  async getRank(userId: number): Promise<number> {
    const player = this.map.get(userId);
    if (!player) return 0;
    let count = 0;
    for (const p of this.map.values()) {
      if (p.size > player.size) count++;
    }
    return count + 1;
  }

  async getTop(limit: number = 10): Promise<Player[]> {
    return Array.from(this.map.values())
      .sort((a, b) => b.size - a.size)
      .slice(0, limit);
  }

  async getBottom(limit: number = 10): Promise<Player[]> {
    return Array.from(this.map.values())
      .sort((a, b) => a.size - b.size)
      .slice(0, limit);
  }

  async getAll(): Promise<Map<number, Player>> {
    return new Map(this.map);
  }
}

describe('DickService', () => {
  let service: DickService;
  let storage: MockPlayersStorageDB;

  beforeEach(() => {
    storage = new MockPlayersStorageDB();
    service = new DickService(storage);
  });

  describe('play()', () => {
    it('должен создать нового игрока при первой игре', async () => {
      const result = await service.play(123, 'john', 'John');

      expect(result.type).toBe('first_time');
      expect(result.player).toBeDefined();
      expect(result.player.userId).toBe(123);
      expect(result.player.username).toBe('john');
      expect(result.player.firstName).toBe('John');
      expect(result.growth).toBeDefined();
      expect(result.growth).toBeGreaterThanOrEqual(-10);
      expect(result.growth).toBeLessThanOrEqual(10);
      expect(result.message).toContain('john');
      expect(result.message).toContain('Следующая попытка завтра!');
    });

    it('должен позволить играть при первой попытке сегодня', async () => {
      const yesterday = '2024-01-29';
      const player: Player = {
        userId: 456,
        username: 'alice',
        firstName: 'Alice',
        size: 10,
        lastUsed: Date.now() - 86400000,
        lastUsedDate: yesterday
      };
      await storage.set(456, player);

      const result = await service.play(456, 'alice', 'Alice');

      expect(result.type).toBe('success');
      expect(result.growth).toBeDefined();
      expect(result.player.size).toBe(10 + result.growth!);
    });

    it('должен вернуть ранг если игрок уже играл сегодня', async () => {
      const today = getMoscowDate();
      const player: Player = {
        userId: 789,
        username: 'bob',
        firstName: 'Bob',
        size: 15,
        lastUsed: Date.now(),
        lastUsedDate: today
      };
      await storage.set(789, player);

      const result = await service.play(789, 'bob', 'Bob');

      expect(result.type).toBe('already_played');
      expect(result.rank).toBeDefined();
      expect(result.message).toContain('уже играл');
      expect(result.message).toContain('15 см');
    });

    it('размер должен изменяться в диапазоне -10..+10', async () => {
      const results: number[] = [];

      for (let i = 0; i < 100; i++) {
        const result = await service.play(i, `user${i}`, `User${i}`);
        if (result.growth !== undefined) {
          results.push(result.growth);
        }
      }

      for (const growth of results) {
        expect(growth).toBeGreaterThanOrEqual(-10);
        expect(growth).toBeLessThanOrEqual(10);
      }

      const uniqueValues = new Set(results);
      expect(uniqueValues.size).toBeGreaterThan(5);
    });
  });

  describe('getTop()', () => {
    it('должен вернуть топ игроков по размеру', async () => {
      await storage.set(1, { userId: 1, username: 'small', firstName: 'Small', size: 5, lastUsed: 0, lastUsedDate: '' });
      await storage.set(2, { userId: 2, username: 'big', firstName: 'Big', size: 50, lastUsed: 0, lastUsedDate: '' });
      await storage.set(3, { userId: 3, username: 'medium', firstName: 'Medium', size: 25, lastUsed: 0, lastUsedDate: '' });

      const top = await service.getTop(3);

      expect(top).toHaveLength(3);
      expect(top[0].size).toBe(50);
      expect(top[1].size).toBe(25);
      expect(top[2].size).toBe(5);
    });

    it('должен ограничивать количество результатов', async () => {
      for (let i = 0; i < 20; i++) {
        await storage.set(i, { userId: i, username: `user${i}`, firstName: `User${i}`, size: i, lastUsed: 0, lastUsedDate: '' });
      }

      const top = await service.getTop(10);

      expect(top).toHaveLength(10);
    });
  });

  describe('getBottom()', () => {
    it('должен вернуть аутсайдеров (с наименьшими размерами)', async () => {
      await storage.set(1, { userId: 1, username: 'small', firstName: 'Small', size: 5, lastUsed: 0, lastUsedDate: '' });
      await storage.set(2, { userId: 2, username: 'big', firstName: 'Big', size: 50, lastUsed: 0, lastUsedDate: '' });
      await storage.set(3, { userId: 3, username: 'medium', firstName: 'Medium', size: 25, lastUsed: 0, lastUsedDate: '' });

      const bottom = await service.getBottom(3);

      expect(bottom).toHaveLength(3);
      expect(bottom[0].size).toBe(5);
      expect(bottom[1].size).toBe(25);
      expect(bottom[2].size).toBe(50);
    });
  });

  describe('getRank()', () => {
    it('должен вернуть правильный ранг игрока', async () => {
      await storage.set(1, { userId: 1, username: 'user1', firstName: 'User1', size: 10, lastUsed: 0, lastUsedDate: '' });
      await storage.set(2, { userId: 2, username: 'user2', firstName: 'User2', size: 50, lastUsed: 0, lastUsedDate: '' });
      await storage.set(3, { userId: 3, username: 'user3', firstName: 'User3', size: 25, lastUsed: 0, lastUsedDate: '' });

      expect(await service.getRank(2)).toBe(1);
      expect(await service.getRank(3)).toBe(2);
      expect(await service.getRank(1)).toBe(3);
    });
  });
});
