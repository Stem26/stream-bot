import { initDatabase } from './database';

/**
 * Скрипт для инициализации/миграции базы данных
 * Запуск: npm run db:migrate
 */

console.log('🚀 Запуск миграции базы данных Telegram бота...');

initDatabase()
  .then(() => {
    console.log('✅ Миграция успешно завершена!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Ошибка при миграции:', error);
    process.exit(1);
  });
