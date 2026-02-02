import { describe, it, expect, beforeEach } from 'vitest';
import { PlayersStorage, Player } from './PlayersStorage';
import * as path from 'path';
import * as fs from 'fs';

describe('PlayersStorage', () => {
  let storage: PlayersStorage;
  const testFilePath = path.join(process.cwd(), 'test-storage-players.json');

  beforeEach(() => {
    // Удаляем тестовый файл перед каждым тестом
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    
    storage = new PlayersStorage(testFilePath);
  });

  describe('get() и set()', () => {
    it('должен сохранять и получать игрока', () => {
      const player: Player = {
        userId: 123,
        username: 'john',
        firstName: 'John',
        size: 10,
        lastUsed: Date.now(),
        lastUsedDate: '2024-01-30'
      };

      storage.set(123, player);
      const retrieved = storage.get(123);

      expect(retrieved).toEqual(player);
    });

    it('должен вернуть undefined для несуществующего игрока', () => {
      const player = storage.get(999);
      expect(player).toBeUndefined();
    });

    it('должен сохранять данные в файл', () => {
      const player: Player = {
        userId: 456,
        username: 'alice',
        firstName: 'Alice',
        size: 20,
        lastUsed: Date.now(),
        lastUsedDate: '2024-01-30'
      };

      storage.set(456, player);

      // Проверяем, что файл создан
      expect(fs.existsSync(testFilePath)).toBe(true);

      // Создаем новый storage и проверяем, что данные загрузились
      const newStorage = new PlayersStorage(testFilePath);
      const retrieved = newStorage.get(456);

      expect(retrieved).toEqual(player);
    });
  });

  describe('getTop()', () => {
    it('должен вернуть топ игроков по убыванию размера', () => {
      storage.set(1, { userId: 1, username: 'user1', firstName: 'User1', size: 10, lastUsed: 0, lastUsedDate: '' });
      storage.set(2, { userId: 2, username: 'user2', firstName: 'User2', size: 50, lastUsed: 0, lastUsedDate: '' });
      storage.set(3, { userId: 3, username: 'user3', firstName: 'User3', size: 25, lastUsed: 0, lastUsedDate: '' });

      const top = storage.getTop(3);

      expect(top[0].size).toBe(50);
      expect(top[1].size).toBe(25);
      expect(top[2].size).toBe(10);
    });

    it('должен ограничивать результаты по limit', () => {
      for (let i = 0; i < 20; i++) {
        storage.set(i, { userId: i, username: `user${i}`, firstName: `User${i}`, size: i, lastUsed: 0, lastUsedDate: '' });
      }

      const top = storage.getTop(5);

      expect(top).toHaveLength(5);
    });
  });

  describe('getBottom()', () => {
    it('должен вернуть аутсайдеров по возрастанию размера', () => {
      storage.set(1, { userId: 1, username: 'user1', firstName: 'User1', size: 10, lastUsed: 0, lastUsedDate: '' });
      storage.set(2, { userId: 2, username: 'user2', firstName: 'User2', size: 50, lastUsed: 0, lastUsedDate: '' });
      storage.set(3, { userId: 3, username: 'user3', firstName: 'User3', size: 25, lastUsed: 0, lastUsedDate: '' });

      const bottom = storage.getBottom(3);

      expect(bottom[0].size).toBe(10); // Самый маленький
      expect(bottom[1].size).toBe(25);
      expect(bottom[2].size).toBe(50); // Самый большой
    });
  });

  describe('getRank()', () => {
    it('должен вернуть правильный ранг игрока', () => {
      storage.set(1, { userId: 1, username: 'user1', firstName: 'User1', size: 10, lastUsed: 0, lastUsedDate: '' });
      storage.set(2, { userId: 2, username: 'user2', firstName: 'User2', size: 50, lastUsed: 0, lastUsedDate: '' });
      storage.set(3, { userId: 3, username: 'user3', firstName: 'User3', size: 25, lastUsed: 0, lastUsedDate: '' });

      expect(storage.getRank(2)).toBe(1); // Самый большой - 1 место
      expect(storage.getRank(3)).toBe(2); // Средний - 2 место
      expect(storage.getRank(1)).toBe(3); // Самый маленький - 3 место
    });

    it('должен вернуть 0 для несуществующего игрока', () => {
      const rank = storage.getRank(999);
      expect(rank).toBe(0);
    });
  });

  describe('getAll()', () => {
    it('должен вернуть копию Map с игроками', () => {
      const player1: Player = { userId: 1, username: 'user1', firstName: 'User1', size: 10, lastUsed: 0, lastUsedDate: '' };
      const player2: Player = { userId: 2, username: 'user2', firstName: 'User2', size: 20, lastUsed: 0, lastUsedDate: '' };
      
      storage.set(1, player1);
      storage.set(2, player2);

      const all = storage.getAll();

      expect(all.size).toBe(2);
      expect(all.get(1)).toEqual(player1);
      expect(all.get(2)).toEqual(player2);
    });
  });
});
