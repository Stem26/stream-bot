import { loadConfig } from './config/env';
import { initServices } from './app/initServices';
import { createBot } from './app/createBot';
import { registerCommands, setupBotCommands } from './app/registerCommands';
import { setupMiddlewares } from './app/setupMiddlewares';
import { setupErrorHandlers } from './app/errorHandlers';
import { initDatabase, closeDatabase } from './database/database';

/**
 * Главная функция запуска бота
 */
async function main() {
  try {
    // 1. Загружаем конфигурацию
    console.log('⚙️ Загрузка конфигурации...');
    const config = loadConfig();

    // 2. Инициализация базы данных
    console.log('📦 Инициализация базы данных...');
    try {
      await initDatabase();
      console.log('✅ База данных готова');
    } catch (error) {
      console.error('❌ Ошибка инициализации БД:', error);
      throw error;
    }

    // Вывод информации о режиме работы
    if (config.isLocal) {
      console.log('==================================================');
      console.log('🔧 ЛОКАЛЬНЫЙ РЕЖИМ РАЗРАБОТКИ');
      console.log('==================================================');
    }

    // 3. Инициализируем сервисы (DI)
    const services = initServices(config);

    // 4. Создаем экземпляр бота с DI
    console.log('🤖 Создание экземпляра бота...');
    const bot = createBot(config, services);

    // 5. Регистрируем команды
    console.log('📝 Регистрация команд...');
    registerCommands(bot);

    // 6. Настраиваем middleware
    console.log('⚙️ Настройка middleware...');
    setupMiddlewares(bot);

    // 7. Настраиваем обработчики ошибок
    setupErrorHandlers(bot);

    // 8. Проверяем соединение с Telegram
    console.log('🔌 Проверка соединения с Telegram...');
    await bot.telegram.getMe();

    // 9. Настраиваем команды в Telegram
    console.log('📋 Настройка команд в Telegram...');
    await setupBotCommands(bot);

    // 10. Запускаем бота
    console.log('🎉 Бот полностью настроен!');
    console.log('🚀 Запуск Telegram бота...');
    await bot.launch({
      dropPendingUpdates: true  // Пропускаем все старые сообщения, накопленные пока бот был выключен
    });

    // 11. Настраиваем graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`🛑 Получен сигнал ${signal}, останавливаем бота...`);
      console.log('🛑 Закрываем соединение с базой данных...');
      await closeDatabase();
      bot.stop(signal);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    console.log('❌ Ошибка при запуске бота:', error);
    process.exit(1);
  }
}

// Запускаем приложение
main();
