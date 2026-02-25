import { initDatabase } from './database';

console.log('🚀 Запуск миграции базы данных Twitch бота...');

initDatabase()
  .then(() => {
    console.log('✅ Миграция успешно завершена!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Ошибка при миграции:', error);
    process.exit(1);
  });
