import { loadConfig } from '../config/env';

function mask(value?: string, opts?: { head?: number; tail?: number }): string {
  if (!value) return '(не задано)';
  const head = opts?.head ?? 6;
  const tail = opts?.tail ?? 4;
  if (value.length <= head + tail + 3) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function yesNo(v: boolean): string {
  return v ? 'ДА' : 'НЕТ';
}

function main(): void {
  const config = loadConfig();

  // Доп. поля, которые не лежат в AppConfig, но важны для "куда подключено".
  const webPort = process.env.WEB_PORT ?? '3000';
  const jwtSecretSet = Boolean(process.env.JWT_SECRET);
  const nightbotTokenSet = Boolean(process.env.NIGHTBOT_TOKEN);
  const overlayBaseUrl = process.env.OVERLAY_API_BASE_URL;
  const overlayToken = process.env.OVERLAY_API_TOKEN;
  const overlayWsUrl = process.env.OVERLAY_EVENTBUS_WS_URL || process.env.OVERLAY_EVENTS_WS_URL;

  const dbUrl = process.env.TWITCH_DATABASE_URL || process.env.DATABASE_URL;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Twitch-service checkup');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`NODE_ENV: ${config.nodeEnv}`);
  console.log(`Режим (локальный): ${yesNo(config.isLocal)}`);
  console.log('');

  console.log('Twitch:');
  console.log(`  channel: ${config.twitch.channel}`);
  console.log(`  clientId: ${mask(config.twitch.clientId, { head: 8, tail: 0 })}`);
  console.log(`  accessToken: ${mask(config.twitch.accessToken)}`);
  console.log(`  refreshToken: ${mask(config.twitch.refreshToken)}`);
  console.log(`  broadcastAccessToken: ${mask(config.twitch.broadcastAccessToken)}`);
  console.log(`  streamerUsername: ${config.streamerUsername ?? '(не задано)'}`);
  console.log('');

  console.log('Telegram:');
  console.log(`  BOT_TOKEN: ${mask(config.telegram.token)}`);
  console.log(`  CHANNEL_ID (stream online): ${config.telegram.channelId ?? '(не задано)'} → ${yesNo(Boolean(config.telegram.channelId))}`);
  console.log(`  CHAT_ID (stream offline): ${config.telegram.chatId ?? '(не задано)'} → ${yesNo(Boolean(config.telegram.chatId))}`);
  console.log('');

  console.log('Web UI:');
  console.log(`  WEB_PORT: ${webPort}`);
  console.log(`  JWT_SECRET задан: ${yesNo(jwtSecretSet)}`);
  console.log('');

  console.log('Интеграции:');
  console.log(`  NIGHTBOT_TOKEN задан: ${yesNo(nightbotTokenSet)}`);
  console.log(`  Overlay API base URL: ${overlayBaseUrl ?? '(не задано)'}`);
  console.log(`  Overlay API token: ${mask(overlayToken)}`);
  console.log(`  Overlay WS URL: ${overlayWsUrl ?? '(не задано)'}`);
  console.log('');

  console.log('Database:');
  console.log(`  URL задан: ${yesNo(Boolean(dbUrl))}`);
  console.log(`  TWITCH_DATABASE_URL: ${mask(process.env.TWITCH_DATABASE_URL, { head: 14, tail: 6 })}`);
  console.log(`  DATABASE_URL: ${mask(process.env.DATABASE_URL, { head: 14, tail: 6 })}`);
  console.log('');

  console.log('Результат:');
  console.log(`  Старт-уведомление в TG: ${yesNo(Boolean(config.telegram.channelId))}`);
  console.log(`  Окончание стрима в TG: ${yesNo(Boolean(config.telegram.chatId))}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main();

