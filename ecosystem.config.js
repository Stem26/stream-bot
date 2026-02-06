module.exports = {
  apps: [
    {
      name: 'telegram-bot',
      script: './services/telegram-service/dist/src/main.js',
      cwd: '/root/stream-bot',
      env: {
        NODE_ENV: 'production'
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '~/.pm2/logs/telegram-bot-error.log',
      out_file: '~/.pm2/logs/telegram-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'twitch-bot',
      script: './services/twitch-service/dist/src/main.js',
      cwd: '/root/stream-bot',
      env: {
        NODE_ENV: 'production'
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '~/.pm2/logs/twitch-bot-error.log',
      out_file: '~/.pm2/logs/twitch-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
