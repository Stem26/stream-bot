import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { AppConfig } from '../types/config';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_LOCAL = NODE_ENV === 'development';

// Путь к корню репозитория (работает и из src/, и из dist/)
// __dirname:
// - src:  services/telegram-service/src/config (4 уровня до корня)
// - dist: services/telegram-service/dist/src/config (5 уровней до корня)
// Определяем корень проверкой наличия package.json
let MONOREPO_ROOT = path.resolve(__dirname, '../../../../');
if (!fs.existsSync(path.join(MONOREPO_ROOT, 'package.json'))) {
  // Если не нашли package.json, значит мы в dist/, поднимаемся ещё выше
  MONOREPO_ROOT = path.resolve(__dirname, '../../../../../');
}

// Определяем какой .env файл загружать из корня монорепы
const envFile = IS_LOCAL ? '.env.local' : '.env';
const envPath = path.resolve(MONOREPO_ROOT, envFile);

console.log(`[ENV] Загрузка конфигурации из: ${envPath} (NODE_ENV=${NODE_ENV})`);

dotenv.config({ path: envPath });

/**
 * Загружает конфигурацию из переменных окружения
 */
export function loadConfig(): AppConfig {
  const botToken = process.env.BOT_TOKEN;
  
  if (!botToken) {
    throw new Error('BOT_TOKEN не найден! Проверьте .env (start) или .env.local (dev).');
  }

  const config: AppConfig = {
    botToken,
    channelId: process.env.CHANNEL_ID,
    allowedAdmins: process.env.ALLOWED_ADMINS 
      ? process.env.ALLOWED_ADMINS.split(',').map(id => parseInt(id.trim())) 
      : [],
    nodeEnv: NODE_ENV,
    isLocal: IS_LOCAL
  };

  return config;
}

// Экспорт для обратной совместимости (используется в старых файлах)
export const BOT_TOKEN = process.env.BOT_TOKEN;
export const CHANNEL_ID = process.env.CHANNEL_ID;
export const ALLOWED_ADMINS = process.env.ALLOWED_ADMINS
  ? process.env.ALLOWED_ADMINS.split(',').map(id => parseInt(id.trim()))
  : [];
export { NODE_ENV, IS_LOCAL };
