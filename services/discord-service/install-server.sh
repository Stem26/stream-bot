#!/bin/bash
# Установка Discord-сервиса на отдельный VPS (только папка services/discord-service).
# Запуск: chmod +x install-server.sh && ./install-server.sh

set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root: sudo ./install-server.sh"
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "==> Обновление пакетов..."
apt-get update -qq

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]; then
  echo "==> Установка Node.js 20..."
  apt-get install -y -qq ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "Node: $(node -v)"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Установка PM2..."
  npm install -g pm2
fi

echo "==> Зависимости и сборка..."
npm install
npm run build

if [ ! -f .env ]; then
  cp env.example .env
  echo ""
  echo "Создан .env — укажите DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_VOICE_CHANNEL_ID:"
  echo "  nano $APP_DIR/.env"
  echo ""
  echo "Затем:"
  echo "  pm2 start $APP_DIR/ecosystem.config.js"
  echo "  pm2 save && pm2 startup"
  exit 0
fi

pm2 start "$APP_DIR/ecosystem.config.js"
pm2 save
echo "Готово: pm2 logs discord-guard --lines 30"
