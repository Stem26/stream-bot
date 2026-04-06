#!/usr/bin/env node
/**
 * Тестовая отправка сообщения в Telegram
 * Использование: node scripts/test-telegram.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Цвета для консоли
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m'
};

function log(color, ...args) {
  console.log(color, ...args, colors.reset);
}

async function testTelegramConnection() {
  log(colors.blue, '\n🔍 ДИАГНОСТИКА СОЕДИНЕНИЯ С TELEGRAM API\n');
  log(colors.blue, '═'.repeat(50));
  
  if (!BOT_TOKEN) {
    log(colors.red, '❌ BOT_TOKEN не найден в .env');
    process.exit(1);
  }
  
  if (!CHAT_ID) {
    log(colors.red, '❌ CHAT_ID не найден в .env');
    process.exit(1);
  }
  
  log(colors.blue, `✓ BOT_TOKEN: ${BOT_TOKEN.substring(0, 10)}...`);
  log(colors.blue, `✓ CHAT_ID: ${CHAT_ID}`);
  log(colors.blue, '═'.repeat(50) + '\n');

  // Шаг 1: DNS резолв
  log(colors.yellow, '📡 Шаг 1: Проверка DNS для api.telegram.org...');
  try {
    const dns = require('dns').promises;
    const addresses = await dns.resolve4('api.telegram.org');
    log(colors.green, `✅ DNS OK: ${addresses.join(', ')}`);
  } catch (error) {
    log(colors.red, `❌ DNS ошибка: ${error.message}`);
    return;
  }

  // Шаг 2: TCP соединение
  log(colors.yellow, '\n🔌 Шаг 2: Проверка TCP соединения...');
  const tcpTest = await new Promise((resolve) => {
    const startTime = Date.now();
    const socket = require('net').connect(443, 'api.telegram.org');
    
    socket.setTimeout(10000);
    
    socket.on('connect', () => {
      const duration = Date.now() - startTime;
      log(colors.green, `✅ TCP соединение OK (${duration}ms)`);
      socket.destroy();
      resolve(true);
    });
    
    socket.on('timeout', () => {
      log(colors.red, '❌ TCP таймаут (10 секунд)');
      socket.destroy();
      resolve(false);
    });
    
    socket.on('error', (err) => {
      log(colors.red, `❌ TCP ошибка: ${err.message}`);
      socket.destroy();
      resolve(false);
    });
  });

  if (!tcpTest) {
    log(colors.red, '\n🔴 Проблема: сервер не может установить TCP соединение с Telegram');
    log(colors.yellow, '\nВозможные причины:');
    log(colors.yellow, '  • Блокировка фаервола (iptables/ufw)');
    log(colors.yellow, '  • Блокировка провайдером');
    log(colors.yellow, '  • Проблемы с маршрутизацией');
    log(colors.yellow, '\nПопробуйте:');
    log(colors.yellow, '  • curl -v https://api.telegram.org/');
    log(colors.yellow, '  • telnet api.telegram.org 443');
    return;
  }

  // Шаг 3: HTTPS запрос (getMe)
  log(colors.yellow, '\n📞 Шаг 3: Тест API (getMe)...');
  const getMeResult = await sendRequest('/getMe', 'GET', null, 10000);
  
  if (!getMeResult.success) {
    log(colors.red, `❌ API ошибка: ${getMeResult.error}`);
    return;
  }
  
  log(colors.green, `✅ API OK: бот @${getMeResult.data.result.username}`);

  // Шаг 4: Отправка тестового сообщения
  log(colors.yellow, '\n📨 Шаг 4: Отправка тестового сообщения...');
  
  const testMessage = {
    chat_id: CHAT_ID,
    text: `🧪 <b>Тестовое сообщение</b>\n\n` +
          `⏰ Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК\n` +
          `🖥️ Сервер: ${require('os').hostname()}\n` +
          `✅ Соединение работает корректно`,
    parse_mode: 'HTML'
  };

  const sendResult = await sendRequest('/sendMessage', 'POST', testMessage, 30000);
  
  if (!sendResult.success) {
    log(colors.red, `❌ Ошибка отправки: ${sendResult.error}`);
    log(colors.red, `   Тип: ${sendResult.errorType}`);
    
    if (sendResult.errorType === 'ETIMEDOUT') {
      log(colors.yellow, '\n⚠️  ДИАГНОЗ: ПРОБЛЕМА С ТАЙМАУТОМ');
      log(colors.yellow, '\nВозможные решения:');
      log(colors.yellow, '  1. Проверьте фаервол: sudo iptables -L');
      log(colors.yellow, '  2. Попробуйте через curl: curl -X POST https://api.telegram.org/bot<TOKEN>/getMe');
      log(colors.yellow, '  3. Проверьте MTU: ip link show | grep mtu');
      log(colors.yellow, '  4. Попробуйте изменить DNS: echo "nameserver 8.8.8.8" >> /etc/resolv.conf');
      log(colors.yellow, '  5. Проверьте роутинг: traceroute api.telegram.org');
    }
    return;
  }

  log(colors.green, `✅ Сообщение отправлено успешно!`);
  log(colors.green, `   Message ID: ${sendResult.data.result.message_id}`);
  log(colors.green, `   Время ответа: ${sendResult.duration}ms`);
  
  log(colors.green, '\n✨ ВСЕ ТЕСТЫ ПРОЙДЕНЫ УСПЕШНО!\n');
}

function sendRequest(path, method, body, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const postData = body ? JSON.stringify(body) : null;
    
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}${path}`,
      method: method,
      headers: postData ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      } : {},
      timeout: timeout
    };

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
              statusCode: res.statusCode
            });
          }
        } catch (e) {
          resolve({ 
            success: false, 
            error: `Parse error: ${e.message}`,
            errorType: 'PARSE_ERROR'
          });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ 
        success: false, 
        error: `Таймаут ${timeout}ms`,
        errorType: 'ETIMEDOUT'
      });
    });

    req.on('error', (error) => {
      resolve({ 
        success: false, 
        error: error.message,
        errorType: error.code || 'UNKNOWN'
      });
    });

    if (postData) {
      req.write(postData);
    }
    
    req.end();
  });
}

// Запуск теста
testTelegramConnection().catch(error => {
  log(colors.red, '❌ Критическая ошибка:', error.message);
  process.exit(1);
});
