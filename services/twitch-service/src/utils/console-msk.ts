/**
 * Патчит console.log и console.error — добавляет метку времени по МСК.
 * Подключать первым при запуске приложения.
 */
function mskTimestamp(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace(' ', ' ');
}

const _log = console.log.bind(console);
const _error = console.error.bind(console);

console.log = (...args: unknown[]) => {
  _log(`[${mskTimestamp()} МСК]:`, ...args);
};

console.error = (...args: unknown[]) => {
  _error(`[${mskTimestamp()} МСК]:`, ...args);
};
