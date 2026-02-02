import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DickService } from './DickService';
import { PlayersStorage, Player } from '../../services/PlayersStorage';
import { getMoscowDate } from '../../utils/date';
import * as path from 'path';
import * as fs from 'fs';

describe('DickService', () => {
  let service: DickService;
  let storage: PlayersStorage;
  const testFilePath = path.join(process.cwd(), 'test-players.json');

  beforeEach(() => {
    // Удаляем тестовый файл если существует
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    
    // Создаем новый storage для каждого теста
    storage = new PlayersStorage(testFilePath);
    service = new DickService(storage);
  });

  describe('play()', () => {
    it('должен создать нового игрока при первой игре', () => {
      const result = service.play(123, 'john', 'John');

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

    it('должен позволить играть при первой попытке сегодня', () => {
      const yesterday = '2024-01-29';
      const player: Player = {
        userId: 456,
        username: 'alice',
        firstName: 'Alice',
        size: 10,
        lastUsed: Date.now() - 86400000,
        lastUsedDate: yesterday
      };
      storage.set(456, player);

      const result = service.play(456, 'alice', 'Alice');

      expect(result.type).toBe('success');
      expect(result.growth).toBeDefined();
      expect(result.player.size).toBe(10 + result.growth!);
    });

    it('должен вернуть ранг если игрок уже играл сегодня', () => {
      const today = getMoscowDate();
      const player: Player = {
        userId: 789,
        username: 'bob',
        firstName: 'Bob',
        size: 15,
        lastUsed: Date.now(),
        lastUsedDate: today
      };
      storage.set(789, player);

      const result = service.play(789, 'bob', 'Bob');

      expect(result.type).toBe('already_played');
      expect(result.rank).toBeDefined();
      expect(result.message).toContain('уже играл');
      expect(result.message).toContain('15 см');
    });

    it('размер должен изменяться в диапазоне -10..+10', () => {
      const results: number[] = [];

      for (let i = 0; i < 100; i++) {
        const result = service.play(i, `user${i}`, `User${i}`);
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
    it('должен вернуть топ игроков по размеру', () => {
      storage.set(1, { userId: 1, username: 'small', firstName: 'Small', size: 5, lastUsed: 0, lastUsedDate: '' });
      storage.set(2, { userId: 2, username: 'big', firstName: 'Big', size: 50, lastUsed: 0, lastUsedDate: '' });
      storage.set(3, { userId: 3, username: 'medium', firstName: 'Medium', size: 25, lastUsed: 0, lastUsedDate: '' });

      const top = service.getTop(3);

      expect(top).toHaveLength(3);
      expect(top[0].size).toBe(50);
      expect(top[1].size).toBe(25);
      expect(top[2].size).toBe(5);
    });

    it('должен ограничивать количество результатов', () => {
      for (let i = 0; i < 20; i++) {
        storage.set(i, { userId: i, username: `user${i}`, firstName: `User${i}`, size: i, lastUsed: 0, lastUsedDate: '' });
      }

      const top = service.getTop(10);

      expect(top).toHaveLength(10);
    });
  });

  describe('getBottom()', () => {
    it('должен вернуть аутсайдеров (с наименьшими размерами)', () => {
      storage.set(1, { userId: 1, username: 'small', firstName: 'Small', size: 5, lastUsed: 0, lastUsedDate: '' });
      storage.set(2, { userId: 2, username: 'big', firstName: 'Big', size: 50, lastUsed: 0, lastUsedDate: '' });
      storage.set(3, { userId: 3, username: 'medium', firstName: 'Medium', size: 25, lastUsed: 0, lastUsedDate: '' });

      const bottom = service.getBottom(3);

      expect(bottom).toHaveLength(3);
      expect(bottom[0].size).toBe(5);
      expect(bottom[1].size).toBe(25);
      expect(bottom[2].size).toBe(50);
    });
  });

  describe('getRank()', () => {
    it('должен вернуть правильный ранг игрока', () => {
      storage.set(1, { userId: 1, username: 'user1', firstName: 'User1', size: 10, lastUsed: 0, lastUsedDate: '' });
      storage.set(2, { userId: 2, username: 'user2', firstName: 'User2', size: 50, lastUsed: 0, lastUsedDate: '' });
      storage.set(3, { userId: 3, username: 'user3', firstName: 'User3', size: 25, lastUsed: 0, lastUsedDate: '' });

      expect(service.getRank(2)).toBe(1);
      expect(service.getRank(3)).toBe(2);
      expect(service.getRank(1)).toBe(3);
    });
  });
});
