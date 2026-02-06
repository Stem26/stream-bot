import * as dotenv from 'dotenv';
import * as path from 'path';
import { AppConfig } from '../types/config';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_LOCAL = NODE_ENV === 'development';

// Путь к корню репозитория (работает и из src/, и из dist/)
// __dirname:
// - src:  services/twitch-service/src/config
// - dist: services/twitch-service/dist/src/config
// Нужно подняться до корня репо: .../services/ -> .../<repo_root>
const MONOREPO_ROOT = path.resolve(__dirname, '../../../../../');

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
  const twitchChannel = process.env.TWITCH_CHANNEL;
  const twitchClientId = process.env.TWITCH_CLIENT_ID;
  const twitchAccessToken = process.env.TWITCH_ACCESS_TOKEN;
  
  if (!botToken) {
    throw new Error('BOT_TOKEN не найден! Проверьте .env (start) или .env.local (dev).');
  }

  if (!twitchChannel) {
    throw new Error('TWITCH_CHANNEL не найден! Укажите имя канала в .env файле.');
  }

  if (!twitchClientId) {
    throw new Error('TWITCH_CLIENT_ID не найден! Укажите Client ID в .env файле.');
  }

  if (!twitchAccessToken) {
    throw new Error('TWITCH_ACCESS_TOKEN не найден! Укажите Access Token в .env файле.');
  }

  const config: AppConfig = {
    telegram: {
      token: botToken,
      channelId: process.env.CHANNEL_ID,
    },
    twitch: {
      channel: twitchChannel,
      clientId: twitchClientId,
      accessToken: twitchAccessToken,
      refreshToken: process.env.TWITCH_REFRESH_TOKEN,
    },
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
export const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL;
export const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
export const TWITCH_ACCESS_TOKEN = process.env.TWITCH_ACCESS_TOKEN;
export const TWITCH_REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN;
export const ALLOWED_ADMINS = process.env.ALLOWED_ADMINS
  ? process.env.ALLOWED_ADMINS.split(',').map(id => parseInt(id.trim()))
  : [];
export { NODE_ENV, IS_LOCAL };
