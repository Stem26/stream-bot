module.exports = {
  apps: [
    {
      name: 'telegram-bot',
      script: './services/telegram-service/dist/src/main.js',
      cwd: '/root/stream-bot',
      env: {
        NODE_ENV: 'production',
        TZ: 'Europe/Moscow'
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '450M',
      min_uptime: 10000, // 10 секунд - минимальное время работы для "успешного" старта
      restart_delay: 5000, // начальная задержка 5 секунд
      exp_backoff_restart_delay: 2000, // задержка растёт: 2s, 4s, 8s, 16s, 32s, затем остаётся на 32s
      max_restart_delay: 60000, // максимальная задержка между рестартами - 60 секунд
      error_file: '~/.pm2/logs/telegram-bot-error.log',
      out_file: '~/.pm2/logs/telegram-bot-out.log',
      log_date_format: ''
    },
    {
      name: 'twitch-bot',
      script: './services/twitch-service/dist/src/main.js',
      cwd: '/root/stream-bot',
      env: {
        NODE_ENV: 'production',
        TZ: 'Europe/Moscow'
      },
      instances: 1,
      exec_mode: 'fork', // 🔥 КРИТИЧЕСКИ ВАЖНО: EventSub WS несовместим с cluster mode
      autorestart: true,
      watch: false,
      max_memory_restart: '450M',
      min_uptime: 10000, // 10 секунд - минимальное время работы для "успешного" старта
      restart_delay: 5000, // начальная задержка 5 секунд
      exp_backoff_restart_delay: 2000, // задержка растёт: 2s, 4s, 8s, 16s, 32s, затем остаётся на 32s
      max_restart_delay: 60000, // максимальная задержка между рестартами - 60 секунд
      error_file: '~/.pm2/logs/twitch-bot-error.log',
      out_file: '~/.pm2/logs/twitch-bot-out.log',
      log_date_format: ''
    }
  ]
};
