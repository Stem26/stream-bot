import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_LOCAL = NODE_ENV === 'development';

// Путь к корню монорепы (аналогично env.ts)
let MONOREPO_ROOT = path.resolve(__dirname, '../../../../');
if (!fs.existsSync(path.join(MONOREPO_ROOT, 'package.json'))) {
  MONOREPO_ROOT = path.resolve(__dirname, '../../../../../');
}

const envFile = IS_LOCAL ? '.env.local' : '.env';
const envPath = path.resolve(MONOREPO_ROOT, envFile);

dotenv.config({ path: envPath });

async function main() {
  const accessToken = process.env.TWITCH_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('❌ TWITCH_ACCESS_TOKEN не найден! Проверьте .env.local (dev) или .env (start).');
    process.exit(1);
  }

  console.log(`[ENV] ${envFile} (NODE_ENV=${NODE_ENV})`);

  const validateRes = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': `OAuth ${accessToken}` }
  });

  const bodyText = await validateRes.text();
  if (!validateRes.ok) {
    console.error(`❌ Token validate failed: ${validateRes.status}`);
    console.error(bodyText);
    process.exit(1);
  }

  console.log('✅ Twitch token валиден');
  console.log(bodyText);
}

main().catch((err) => {
  console.error('❌ Ошибка проверки токена:', err);
  process.exit(1);
});
