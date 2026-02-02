import * as dotenv from 'dotenv';
import * as path from 'path';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_LOCAL = NODE_ENV === 'development';
const envFile = IS_LOCAL ? '.env.local' : '.env';

dotenv.config({ path: path.resolve(process.cwd(), envFile) });

async function main() {
  const accessToken = process.env.TWITCH_ACCESS_TOKEN;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const channelName = process.env.TWITCH_CHANNEL;

  if (!accessToken || !clientId || !channelName) {
    console.error('❌ Не хватает TWITCH_ACCESS_TOKEN / TWITCH_CLIENT_ID / TWITCH_CHANNEL.');
    process.exit(1);
  }

  const message = process.argv.slice(2).join(' ').trim() || '📣 Тестовое announcement';

  console.log(`[ENV] ${envFile} (NODE_ENV=${NODE_ENV})`);

  const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${channelName}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id': clientId
    }
  });

  if (!userRes.ok) {
    throw new Error(`Ошибка получения broadcaster_id: ${userRes.status} ${await userRes.text()}`);
  }

  const userData = await userRes.json() as { data: Array<{ id: string }> };
  if (!userData.data[0]) {
    throw new Error(`Канал ${channelName} не найден`);
  }

  const broadcasterId = userData.data[0].id;

  const validateRes = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': `OAuth ${accessToken}` }
  });

  if (!validateRes.ok) {
    throw new Error(`Token validate failed: ${await validateRes.text()}`);
  }

  const validateData = await validateRes.json() as { user_id: string };
  const moderatorId = validateData.user_id;

  const announcementRes = await fetch(
    `https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${broadcasterId}&moderator_id=${moderatorId}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message,
        color: 'purple'
      })
    }
  );

  if (!announcementRes.ok) {
    throw new Error(`Ошибка отправки announcement: ${announcementRes.status} ${await announcementRes.text()}`);
  }

  console.log('✅ Тестовое announcement отправлено');
}

main().catch((err) => {
  console.error('❌ Ошибка тестового announcement:', err);
  process.exit(1);
});
