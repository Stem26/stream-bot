import * as fs from 'fs';
import * as path from 'path';
import { CHANNEL_ID } from '../config/env';

// Определяем корень монорепозитория
const MONOREPO_ROOT = (() => {
  let root = process.cwd();
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  root = path.resolve(process.cwd(), '../..');
  if (fs.existsSync(path.join(root, 'package.json'))) {
    return root;
  }
  return process.cwd();
})();

// Файл для хранения ID канала (если не указан в .env)
const CHANNEL_FILE = path.join(MONOREPO_ROOT, 'channel_id.txt');

// Функция для получения ID канала
export function getChannelId(): string | null {
  if (CHANNEL_ID) {
    return CHANNEL_ID;
  }

  try {
    if (fs.existsSync(CHANNEL_FILE)) {
      return fs.readFileSync(CHANNEL_FILE, 'utf-8').trim();
    }
  } catch (error) {
    console.error('Ошибка при чтении channel_id.txt:', error);
  }

  return null;
}

// Функция для сохранения ID канала
export function saveChannelId(channelId: string): void {
  try {
    fs.writeFileSync(CHANNEL_FILE, channelId, 'utf-8');
  } catch (error) {
    console.error('Ошибка при сохранении channel_id.txt:', error);
  }
}


