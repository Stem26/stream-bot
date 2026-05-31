// PM2 только для Discord — второй сервер или запуск без корневого ecosystem.config.js
const path = require('path');
const appDir = __dirname;

module.exports = {
  apps: [
    {
      name: 'discord-guard',
      script: path.join(appDir, 'dist/src/main.js'),
      cwd: appDir,
      env: {
        NODE_ENV: 'production',
        TZ: 'Europe/Moscow',
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // После npm run build перезапуск, когда обновится dist/
      watch: ['dist'],
      watch_delay: 1000,
      ignore_watch: ['node_modules', '.git', '.env', '.env.local'],
      max_memory_restart: '200M',
      min_uptime: 10_000,
      restart_delay: 5_000,
      exp_backoff_restart_delay: 2_000,
      max_restart_delay: 60_000,
      error_file: path.join(process.env.HOME || '/root', '.pm2/logs/discord-guard-error.log'),
      out_file: path.join(process.env.HOME || '/root', '.pm2/logs/discord-guard-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
