#!/usr/bin/env node
/**
 * Создание бэкапа PostgreSQL и отправка в Telegram
 * Использование: node scripts/backup-db.js [telegram_chat_id]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');

const execAsync = promisify(exec);

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL || process.env.TELEGRAM_DATABASE_URL;
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

async function createBackup() {
  console.log('📦 Создание бэкапа PostgreSQL...');

  // Создать папку backups если нет
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const filename = `stream_bot_backup_${timestamp}.sql`;
  const filepath = path.join(BACKUP_DIR, filename);

  try {
    // Экспортировать DATABASE_URL для pg_dump
    const dumpCommand = process.platform === 'win32'
      ? `set PGPASSWORD=${getDatabasePassword(DATABASE_URL)} && pg_dump -h ${getDatabaseHost(DATABASE_URL)} -U ${getDatabaseUser(DATABASE_URL)} -d ${getDatabaseName(DATABASE_URL)} -f "${filepath}"`
      : `PGPASSWORD="${getDatabasePassword(DATABASE_URL)}" pg_dump -h ${getDatabaseHost(DATABASE_URL)} -U ${getDatabaseUser(DATABASE_URL)} -d ${getDatabaseName(DATABASE_URL)} -f "${filepath}"`;

    await execAsync(dumpCommand);

    const stats = fs.statSync(filepath);
    console.log(`✅ Бэкап создан: ${filename} (${(stats.size / 1024).toFixed(2)} KB)`);

    return { filepath, filename, size: stats.size };
  } catch (error) {
    console.error('❌ Ошибка создания бэкапа:', error.message);
    throw error;
  }
}

function getDatabaseHost(url) {
  const match = url.match(/@([^:/]+)/);
  return match ? match[1] : 'localhost';
}

function getDatabaseUser(url) {
  const match = url.match(/\/\/([^:]+):/);
  return match ? match[1] : 'postgres';
}

function getDatabasePassword(url) {
  const match = url.match(/:([^@]+)@/);
  return match ? match[1] : '';
}

function getDatabaseName(url) {
  const match = url.match(/\/([^?]+)(\?|$)/);
  return match ? match[1] : 'stream_bot';
}

async function sendToTelegram(filepath, filename, chatId) {
  if (!BOT_TOKEN) {
    console.log('⚠️  BOT_TOKEN не найден, пропускаем отправку в Telegram');
    return;
  }

  if (!chatId) {
    console.log('⚠️  Chat ID не указан, пропускаем отправку в Telegram');
    return;
  }

  console.log(`📤 Отправка бэкапа в Telegram (chat: ${chatId})...`);

  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(filepath), filename);
    form.append('caption', `🗄️ Бэкап базы данных\n📅 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`);

    const request = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendDocument`,
      method: 'POST',
      headers: form.getHeaders()
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (response.statusCode === 200) {
          console.log('✅ Бэкап отправлен в Telegram');
          resolve();
        } else {
          console.error('❌ Ошибка отправки:', data);
          reject(new Error(`HTTP ${response.statusCode}: ${data}`));
        }
      });
    });

    request.on('error', reject);
    form.pipe(request);
  });
}

async function main() {
  const chatId = process.argv[2] || process.env.BACKUP_ADMIN_ID;

  if (!chatId) {
    console.error('❌ Не указан chat_id.');
    console.error('   Использование: node backup-db.js <chat_id>');
    console.error('   Или установите BACKUP_ADMIN_ID в .env');
    process.exit(1);
  }

  try {
    const backup = await createBackup();
    await sendToTelegram(backup.filepath, backup.filename, chatId);
    console.log('✅ Бэкап завершён успешно!');
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { createBackup, sendToTelegram };
