import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { AppConfig } from '../types/config';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_LOCAL = NODE_ENV === 'development';

// Путь к корню репозитория (работает и из src/, и из dist/)
// __dirname:
// - src:  services/twitch-service/src/config (4 уровня до корня)
// - dist: services/twitch-service/dist/src/config (5 уровней до корня)
// Определяем корень проверкой наличия package.json
let MONOREPO_ROOT = path.resolve(__dirname, '../../../../');
if (!fs.existsSync(path.join(MONOREPO_ROOT, 'package.json'))) {
  // Если не нашли package.json, значит мы в dist/, поднимаемся ещё выше
  MONOREPO_ROOT = path.resolve(__dirname, '../../../../../');
}

// .env — база; .env.local — переопределения в dev (токены можно держать в любом из файлов)
const envBasePath = path.resolve(MONOREPO_ROOT, '.env');
const envLocalPath = path.resolve(MONOREPO_ROOT, '.env.local');
dotenv.config({ path: envBasePath });
if (IS_LOCAL && fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}
const envSources = [fs.existsSync(envBasePath) ? '.env' : null, IS_LOCAL && fs.existsSync(envLocalPath) ? '.env.local' : null]
  .filter(Boolean)
  .join(' + ');
console.log(`[ENV] Загрузка конфигурации: ${envSources || 'нет файлов'} (NODE_ENV=${NODE_ENV})`);

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
      chatId: process.env.CHAT_ID,
    },
    twitch: {
      channel: twitchChannel,
      clientId: twitchClientId,
      accessToken: twitchAccessToken,
      refreshToken: process.env.TWITCH_REFRESH_TOKEN,
      broadcastAccessToken: process.env.BROADCAST_TWITCH_ACCESS_TOKEN || undefined,
    },
    allowedAdmins: process.env.ALLOWED_ADMINS 
      ? process.env.ALLOWED_ADMINS.split(',').map(id => parseInt(id.trim())) 
      : [],
    streamerUsername: process.env.STREAMER_USERNAME?.trim().toLowerCase() 
      || 'kunilika666', // Дефолтный username стримера (можно переопределить через .env)
    nodeEnv: NODE_ENV,
    isLocal: IS_LOCAL
  };

  return config;
}

// Экспорт для обратной совместимости (используется в старых файлах)
export const BOT_TOKEN = process.env.BOT_TOKEN;
export const CHANNEL_ID = process.env.CHANNEL_ID;
export const CHAT_ID = process.env.CHAT_ID;
export const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL;
export const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
export const TWITCH_ACCESS_TOKEN = process.env.TWITCH_ACCESS_TOKEN;
export const TWITCH_REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN;
export const ALLOWED_ADMINS = process.env.ALLOWED_ADMINS
  ? process.env.ALLOWED_ADMINS.split(',').map(id => parseInt(id.trim()))
  : [];
export const STREAMER_USERNAME = process.env.STREAMER_USERNAME?.trim().toLowerCase() 
  || 'kunilika666'; // Дефолтный username стримера

/** DonateX External token (кабинет → Настройки → Api). REST + SignalR. */
export const DONATEX_EXTERNAL_TOKEN = process.env.DONATEX_EXTERNAL_TOKEN?.trim() || undefined;

/** Отдельная БД для DonateX; если пусто — используется DATABASE_URL. */
export const DONATEX_DATABASE_URL = process.env.DONATEX_DATABASE_URL?.trim() || undefined;

export { NODE_ENV, IS_LOCAL };
