import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { ChatClient } from '@twurple/chat';
import { StaticAuthProvider } from '@twurple/auth';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_LOCAL = NODE_ENV === 'development';

// Определяем корень монорепы (работает и из src/, и из dist/)
// __dirname:
// - src:  services/twitch-service/src/scripts (4 уровня до корня)
// - dist: services/twitch-service/dist/src/scripts (5 уровней до корня)
let MONOREPO_ROOT = path.resolve(__dirname, '../../../../');
if (!fs.existsSync(path.join(MONOREPO_ROOT, 'package.json'))) {
  // Если не нашли package.json, значит мы в dist/, поднимаемся ещё выше
  MONOREPO_ROOT = path.resolve(__dirname, '../../../../../');
}

const envFile = IS_LOCAL ? '.env.local' : '.env';
const envPath = path.resolve(MONOREPO_ROOT, envFile);

console.log(`[ENV] Загрузка конфигурации из: ${envPath} (NODE_ENV=${NODE_ENV})`);

dotenv.config({ path: envPath });

async function main() {
  const accessToken = process.env.TWITCH_ACCESS_TOKEN;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const channelName = process.env.TWITCH_CHANNEL;

  if (!accessToken || !clientId || !channelName) {
    console.error('❌ Не хватает TWITCH_ACCESS_TOKEN / TWITCH_CLIENT_ID / TWITCH_CHANNEL.');
    process.exit(1);
  }

  const message = process.argv.slice(2).join(' ').trim() || '📣 Тестовое сообщение';

  console.log(`[ENV] ${envFile} (NODE_ENV=${NODE_ENV})`);
  console.log(`[Канал] ${channelName}`);
  console.log(`[Сообщение] ${message}`);

  // Создаём ChatClient для отправки обычного сообщения
  const authProvider = new StaticAuthProvider(clientId, accessToken);
  const chatClient = new ChatClient({ authProvider, channels: [channelName] });

  console.log('🔌 Подключение к Twitch чату...');

  await chatClient.connect();

  console.log('✅ Подключено к чату');
  console.log('📤 Отправка сообщения...');

  // Отправляем обычное текстовое сообщение в чат
  await chatClient.say(channelName, message);

  console.log('✅ Тестовое сообщение отправлено');

  // Отключаемся
  await chatClient.quit();
  
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Ошибка отправки сообщения:', err);
  process.exit(1);
});
