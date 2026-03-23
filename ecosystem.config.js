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
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,
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
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,
      error_file: '~/.pm2/logs/twitch-bot-error.log',
      out_file: '~/.pm2/logs/twitch-bot-out.log',
      log_date_format: ''
    }
  ]
};
