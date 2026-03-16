/**
 * Скрипт добавления админа в БД.
 * Использование: npm run admin:add -- username password
 * Или: npx ts-node src/scripts/add-admin.ts username password
 */
import * as bcrypt from 'bcrypt';
import { initDatabase, getPool, closeDatabase } from '../database/database';

const BCRYPT_ROUNDS = 10;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const username = args[0]?.trim();
  const password = args[1];

  if (!username || !password) {
    console.error('Использование: npm run admin:add -- <username> <password>');
    console.error('Пример: npm run admin:add -- admin mypassword');
    process.exit(1);
  }

  if (username.length < 2 || username.length > 80) {
    console.error('Логин должен быть от 2 до 80 символов');
    process.exit(1);
  }

  if (password.length < 6) {
    console.error('Пароль должен быть не короче 6 символов');
    process.exit(1);
  }

  await initDatabase();
  const pool = getPool();

  try {
    const existing = await pool.query(
      'SELECT id FROM admin_users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (existing.rows.length > 0) {
      console.error(`Пользователь "${username}" уже существует`);
      process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await pool.query(
      'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
      [username, passwordHash]
    );
    console.log(`✅ Админ "${username}" добавлен`);
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
