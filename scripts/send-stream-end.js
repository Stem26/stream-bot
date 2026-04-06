#!/usr/bin/env node
/**
 * Ручная отправка уведомления об окончании стрима в Telegram
 * Использование: node scripts/send-stream-end.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не найден в .env');
  process.exit(1);
}

if (!CHAT_ID) {
  console.error('❌ CHAT_ID не найден в .env');
  process.exit(1);
}

// Данные из последнего стрима (из логов)
const streamData = {
  broadcasterName: 'kunilika666',
  duration: '5ч 55мин',
  peak: 74,
  followsCount: 1,
  startTime: '2026-04-06 13:20 МСК'
};

function buildMessage() {
  return `🔴 <b>Стрим завершён!</b>

👤 Канал: ${streamData.broadcasterName}
⏱️ Длительность: ${streamData.duration}
👥 Пик зрителей: ${streamData.peak}
💜 Новых подписчиков: ${streamData.followsCount}

📅 Начало: ${streamData.startTime}
⏰ Конец: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`;
}

async function sendMessage(message, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(`\n📨 Попытка ${attempt}/${retries}: Отправка уведомления...`);
    
    const result = await sendTelegramRequest(message, 30000);
    
    if (result.success) {
      console.log(`✅ Сообщение успешно отправлено!`);
      console.log(`   Message ID: ${result.data.result.message_id}`);
      console.log(`   Время ответа: ${result.duration}ms`);
      return true;
    }
    
    console.error(`❌ Ошибка: ${result.error}`);
    console.error(`   Тип ошибки: ${result.errorType}`);
    
    if (result.errorType === 'ETIMEDOUT') {
      console.warn(`⚠️  Таймаут соединения с Telegram API`);
    }
    
    if (attempt < retries) {
      const delay = attempt * 2000;
      console.log(`⏳ Ожидание ${delay/1000} секунд перед повтором...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.error(`\n❌ Не удалось отправить сообщение после ${retries} попыток`);
  return false;
}

function sendTelegramRequest(text, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    
    const payload = {
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    };
    
    const postData = JSON.stringify(payload);
    
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: timeout
    };

    console.log(`🔗 Подключение к: ${options.hostname}${options.path}`);
    console.log(`⏱️  Таймаут: ${timeout}ms`);
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const duration = Date.now() - startTime;
        
        try {
          const parsed = JSON.parse(data);
          
          if (res.statusCode === 200) {
            resolve({ success: true, data: parsed, duration });
          } else {
            resolve({ 
              success: false, 
              error: parsed.description || data,
              errorType: 'HTTP_ERROR',
              statusCode: res.statusCode,
              duration
            });
          }
        } catch (e) {
          resolve({ 
            success: false, 
            error: `Parse error: ${e.message}`,
            errorType: 'PARSE_ERROR',
            duration
          });
        }
      });
    });

    req.on('timeout', () => {
      const duration = Date.now() - startTime;
      console.warn(`⏱️  Таймаут после ${duration}ms`);
      req.destroy();
      resolve({ 
        success: false, 
        error: `Request timeout after ${timeout}ms`,
        errorType: 'ETIMEDOUT',
        duration
      });
    });

    req.on('error', (error) => {
      const duration = Date.now() - startTime;
      resolve({ 
        success: false, 
        error: error.message,
        errorType: error.code || 'UNKNOWN',
        duration
      });
    });

    req.write(postData);
    req.end();
  });
}

async function main() {
  console.log('\n📊 ДАННЫЕ СТРИМА:');
  console.log('═'.repeat(50));
  console.log(`  Канал: ${streamData.broadcasterName}`);
  console.log(`  Длительность: ${streamData.duration}`);
  console.log(`  Пик зрителей: ${streamData.peak}`);
  console.log(`  Подписчиков: ${streamData.followsCount}`);
  console.log('═'.repeat(50));
  
  const message = buildMessage();
  console.log('\n📝 ТЕКСТ СООБЩЕНИЯ:');
  console.log('─'.repeat(50));
  console.log(message.replace(/<\/?b>/g, ''));
  console.log('─'.repeat(50));
  
  const success = await sendMessage(message);
  
  if (!success) {
    console.log('\n🔧 РЕКОМЕНДАЦИИ ДЛЯ ДИАГНОСТИКИ:');
    console.log('  1. Запустите: node scripts/test-telegram.js');
    console.log('  2. Проверьте: curl -v https://api.telegram.org/');
    console.log('  3. Проверьте фаервол: sudo iptables -L');
    console.log('  4. Проверьте DNS: nslookup api.telegram.org');
    process.exit(1);
  }
  
  console.log('\n✨ Готово!\n');
}

main().catch(error => {
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
});
