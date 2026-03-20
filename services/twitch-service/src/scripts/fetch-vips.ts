/**
 * Выводит всех VIP канала через Helix GET /channels/vips.
 * Нужны: TWITCH_CLIENT_ID, токен с channel:read:vips или moderator:read:vips,
 * TWITCH_CHANNEL (логин канала без #).
 *
 * Запуск из корня монорепы или из services/twitch-service:
 *   npm run twitch:vips:list --workspace twitch-service
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_LOCAL = NODE_ENV === 'development';

let MONOREPO_ROOT = path.resolve(__dirname, '../../../../');
if (!fs.existsSync(path.join(MONOREPO_ROOT, 'package.json'))) {
  MONOREPO_ROOT = path.resolve(__dirname, '../../../../../');
}

const envFile = IS_LOCAL ? '.env.local' : '.env';
dotenv.config({ path: path.resolve(MONOREPO_ROOT, envFile) });

type VipRow = { user_id: string; user_login: string; user_name: string };

async function helixJson<T>(
  url: string,
  accessToken: string,
  clientId: string,
): Promise<{ ok: boolean; status: number; data: T; raw: string }> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': clientId,
    },
  });
  const raw = await res.text();
  let data: T = {} as T;
  try {
    data = JSON.parse(raw) as T;
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data, raw };
}

async function main() {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const channel = process.env.TWITCH_CHANNEL?.replace(/^#/, '').trim().toLowerCase();
  const accessToken =
    process.env.BROADCAST_TWITCH_ACCESS_TOKEN?.trim() || process.env.TWITCH_ACCESS_TOKEN?.trim();

  if (!clientId) {
    console.error('❌ TWITCH_CLIENT_ID не задан');
    process.exit(1);
  }
  if (!accessToken) {
    console.error('❌ Нужен BROADCAST_TWITCH_ACCESS_TOKEN или TWITCH_ACCESS_TOKEN');
    process.exit(1);
  }
  if (!channel) {
    console.error('❌ TWITCH_CHANNEL не задан');
    process.exit(1);
  }

  console.log(`[ENV] ${envFile} (NODE_ENV=${NODE_ENV})`);
  console.log(`Канал: ${channel}`);

  const usersUrl = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(channel)}`;
  const usersRes = await helixJson<{ data?: Array<{ id: string }> }>(usersUrl, accessToken, clientId);
  if (!usersRes.ok || !usersRes.data.data?.[0]?.id) {
    console.error(`❌ Не удалось получить broadcaster_id: ${usersRes.status}`);
    console.error(usersRes.raw);
    process.exit(1);
  }

  const broadcasterId = usersRes.data.data[0].id;
  const all: VipRow[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL('https://api.twitch.tv/helix/channels/vips');
    url.searchParams.set('broadcaster_id', broadcasterId);
    url.searchParams.set('first', '100');
    if (cursor) url.searchParams.set('after', cursor);

    const res = await helixJson<{
      data?: VipRow[];
      pagination?: { cursor?: string };
    }>(url.toString(), accessToken, clientId);

    if (!res.ok) {
      console.error(`❌ Ошибка VIP API: ${res.status}`);
      console.error(res.raw);
      if (res.status === 401 || res.status === 403) {
        console.error('Подсказка: добавь scope channel:read:vips (токен стримера) или moderator:read:vips и переавторизуйся.');
      }
      process.exit(1);
    }

    const chunk = res.data.data ?? [];
    all.push(...chunk);
    cursor = res.data.pagination?.cursor;
  } while (cursor);

  const byId = new Map<string, VipRow>();
  for (const v of all) {
    if (v.user_id && !byId.has(v.user_id)) byId.set(v.user_id, v);
  }
  const unique = [...byId.values()].sort((a, b) =>
    a.user_login.localeCompare(b.user_login, undefined, { sensitivity: 'base' }),
  );

  console.log(`\n✅ Всего VIP: ${unique.length}\n`);
  for (const v of unique) {
    console.log(v.user_login);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
