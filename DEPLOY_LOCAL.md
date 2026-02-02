/*
================== PM2 / ДЕПЛОЙ БОТА ==================

Команды PM2 для управления ботом:

Остановить:
pm2 stop telegram-bot

Перезапустить:
pm2 restart telegram-bot

Удалить из списка PM2:
pm2 delete telegram-bot

Проверить статус:
pm2 list

Посмотреть логи:
pm2 logs telegram-bot

Остановка — бот не работает, но остается в списке PM2.
Запуск снова:
pm2 start telegram-bot

Перезапуск — бот останавливается и сразу запускается заново
(быстрее, чем stop + start).

---------------- ПОРЯДОК ОБНОВЛЕНИЯ БОТА ----------------

1. ЛОКАЛЬНО (на компьютере):
    - Внести изменения в код
    - Открыть GitHub Desktop
    - Сделать Commit
    - Сделать Push в GitHub

2. СЕРВЕР (вручную):
   cd /root/telegram-bot-repo
   git pull origin main
   npm install
   npm run build
   pm2 restart telegram-bot
========================================================
*/
cd /root/telegram-bot-repo
nano .env
nano /root/telegram-bot-repo/twitch-players.json
nano /root/telegram-bot-repo/.env
npm run nightbot:send -- "@Kunilika666 Милый стример "
cd /root/telegram-bot-repo && npm run nightbot:send -- "@Kunilika666 Милый стример"
5. npm start
6. Прод ID: -1001983402471
   Заходя на канал используй команду !dick"
   !dick !top_dick !bottomdick

8. npm test

# Одноразовый запуск
npm run test:run

# С покрытием кода
npm run test:coverage

# Для теста с продовым ботом
npm run test:stream

# Для теста с тестовым ботом
npm run test:stream:dev