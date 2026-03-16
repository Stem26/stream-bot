/**
 * Удаление админа из БД.
 * Использование: npm run admin:remove -- username
 */
import { initDatabase, getPool, closeDatabase } from '../database/database';

async function main(): Promise<void> {
  const username = process.argv[2]?.trim();
  if (!username) {
    console.error('Использование: npm run admin:remove -- <username>');
    console.error('Пример: npm run admin:remove -- admin');
    process.exit(1);
  }

  await initDatabase();
  const pool = getPool();

  try {
    const result = await pool.query(
      'DELETE FROM admin_users WHERE LOWER(username) = LOWER($1) RETURNING id',
      [username]
    );
    if (result.rowCount === 0) {
      console.error(`Пользователь "${username}" не найден`);
      process.exit(1);
    }
    console.log(`✅ Админ "${username}" удалён`);
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
