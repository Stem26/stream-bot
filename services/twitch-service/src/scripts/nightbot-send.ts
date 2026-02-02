import * as dotenv from 'dotenv';
import * as path from 'path';
import { ChatClient } from '@twurple/chat';
import { StaticAuthProvider } from '@twurple/auth';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_LOCAL = NODE_ENV === 'development';
const envFile = IS_LOCAL ? '.env.local' : '.env';

dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL;
const TWITCH_ACCESS_TOKEN = process.env.TWITCH_ACCESS_TOKEN;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;

async function main() {
  const message = process.argv.slice(2).join(' ').trim();

  if (!TWITCH_ACCESS_TOKEN || !TWITCH_CLIENT_ID || !TWITCH_CHANNEL) {
    console.error('❌ Не найдены необходимые переменные окружения:');
    if (!TWITCH_ACCESS_TOKEN) console.error('   - TWITCH_ACCESS_TOKEN');
    if (!TWITCH_CLIENT_ID) console.error('   - TWITCH_CLIENT_ID');
    if (!TWITCH_CHANNEL) console.error('   - TWITCH_CHANNEL');
    console.error(`Добавь их в ${envFile}`);
    process.exit(1);
  }

  if (!message) {
    console.log('Использование:');
    console.log('  npm run nightbot:send -- "Привет, чат!"');
    console.log('  npm run nightbot:send -- "@Kunilika666 Милый стример"');
    console.log('');
    console.log('(сообщение с @ для упоминания пользователя)');
    process.exit(0);
  }

  console.log('🔄 Подключение к Twitch чату...');
  console.log(`   Канал: ${TWITCH_CHANNEL}`);
  console.log(`   Сообщение: ${message}`);
  console.log(`[ENV] ${envFile} (NODE_ENV=${NODE_ENV})`);

  try {
    const authProvider = new StaticAuthProvider(TWITCH_CLIENT_ID, TWITCH_ACCESS_TOKEN);

    const chatClient = new ChatClient({
      authProvider,
      channels: [TWITCH_CHANNEL]
    });

    await chatClient.connect();
    console.log('✅ Подключено к чату');

    // Небольшая задержка для стабильности соединения
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('📤 Отправка сообщения...');
    await chatClient.say(TWITCH_CHANNEL, message);
    console.log('✅ Сообщение успешно отправлено в чат Twitch!');

    await chatClient.quit();
    console.log('🔌 Отключено от чата');

    process.exit(0);
  } catch (error: any) {
    console.error('❌ Ошибка при отправке сообщения:');
    console.error('   ', error.message || error);

    if (error.message?.includes('authentication')) {
      console.error('');
      console.error('💡 Проверьте, что ваш TWITCH_ACCESS_TOKEN имеет права:');
      console.error('   - chat:read');
      console.error('   - chat:edit');
    }

    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Ошибка отправки в Twitch чат:', err);
  process.exit(1);
});
