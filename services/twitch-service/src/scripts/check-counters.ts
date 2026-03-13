import { initDatabase, query, closeDatabase } from '../database/database';

async function checkCounters() {
  try {
    await initDatabase();
    
    console.log('📊 Проверка счётчиков в БД:\n');
    
    const counters = await query('SELECT id, trigger, response_template, value, enabled FROM counters ORDER BY id');
    
    if (counters.length === 0) {
      console.log('⚠️  Счётчики не найдены в БД!');
    } else {
      console.log(`Найдено счётчиков: ${counters.length}\n`);
      
      counters.forEach((c: any) => {
        console.log(`ID: ${c.id}`);
        console.log(`Триггер: ${c.trigger}`);
        console.log(`Шаблон: ${c.response_template}`);
        console.log(`Значение: ${c.value}`);
        console.log(`Статус: ${c.enabled ? '✅ Включен' : '❌ Выключен'}`);
        console.log('─'.repeat(50));
      });
    }
    
    await closeDatabase();
  } catch (error) {
    console.error('❌ Ошибка:', error);
    await closeDatabase();
    process.exit(1);
  }
}

checkCounters();
