import { Telegraf } from 'telegraf';
import { BotContext } from '../types/context';
import { dickCommand } from './dick';
import { topDickCommand } from './topDick';
import { bottomDickCommand } from './bottomDick';
import { hornyCommand } from './horny';
import { furryCommand } from './furry';
import { futureCommand } from './future';
import { allCommand } from './all';
import { postCommand } from './post';
import { canUsePost } from '../utils/permissions';

// Единый тип хендлера - всегда принимает bot (но не обязан его использовать)
export type BotCommandHandler = (ctx: BotContext, bot: Telegraf<BotContext>) => void | Promise<void>;

// Интерфейс команды
export interface BotCommand {
  name: string;
  description: string;
  category?: string; // Категория для группировки в /help
  
  // Хендлер команды (всегда принимает bot)
  handler: BotCommandHandler;
  
  // Флаги видимости и доступа
  adminOnly?: boolean; // Команда только для админов
  showInMenu?: boolean; // Показывать в меню Telegram (setMyCommands)
  showInHelp?: boolean; // Показывать в /help
  
  // Кастомная проверка доступа (для сложных случаев)
  canAccess?: (ctx: BotContext) => boolean;
}

// Реестр всех команд бота
export const commands: BotCommand[] = [
  {
    name: 'start',
    description: 'Начать работу с ботом',
    category: '📋 Основные',
    showInMenu: true,
    showInHelp: true,
    handler: (ctx: BotContext, bot: Telegraf<BotContext>) => {
      const user = ctx.from;
      ctx.reply(
        `Привет, ${user?.first_name}! 👋\n\n` +
        'Я простой Telegram бот. Используй /help чтобы увидеть список команд.'
      );
    }
  },
  {
    name: 'help',
    description: 'Показать список команд',
    category: '📋 Основные',
    showInMenu: true,
    showInHelp: true,
    handler: generateHelpHandler // Автогенерация /help
  },
  {
    name: 'dick',
    description: 'Увеличить размер',
    category: '🎮 Игровые команды',
    showInMenu: true,
    showInHelp: true,
    handler: (ctx: BotContext, bot: Telegraf<BotContext>) => dickCommand(ctx)
  },
  {
    name: 'top_dick',
    description: 'Топ 10 игроков',
    category: '🎮 Игровые команды',
    showInMenu: true,
    showInHelp: true,
    handler: (ctx: BotContext, bot: Telegraf<BotContext>) => topDickCommand(ctx)
  },
  {
    name: 'bottom_dick',
    description: 'Топ 10 аутсайдеров',
    category: '🎮 Игровые команды',
    showInMenu: true,
    showInHelp: true,
    handler: (ctx: BotContext, bot: Telegraf<BotContext>) => bottomDickCommand(ctx)
  },
  {
    name: 'horny',
    description: 'Узнать свой уровень хорни',
    category: '🎮 Игровые команды',
    showInMenu: true,
    showInHelp: true,
    handler: (ctx: BotContext, bot: Telegraf<BotContext>) => hornyCommand(ctx)
  },
  {
    name: 'furry',
    description: 'Узнать свой уровень фури',
    category: '🎮 Игровые команды',
    showInMenu: true,
    showInHelp: true,
    handler: (ctx: BotContext, bot: Telegraf<BotContext>) => furryCommand(ctx)
  },
  {
    name: 'future',
    description: 'Получить предсказание будущего',
    category: '🎮 Игровые команды',
    showInMenu: true,
    showInHelp: true,
    handler: (ctx: BotContext, bot: Telegraf<BotContext>) => futureCommand(ctx)
  },
  {
    name: 'all',
    description: 'Dick, предсказание, horny и furry одним сообщением',
    category: '🎮 Игровые команды',
    showInMenu: true,
    showInHelp: true,
    handler: (ctx: BotContext, bot: Telegraf<BotContext>) => allCommand(ctx)
  },
  {
    name: 'post',
    description: 'Опубликовать сообщение в канал/группу',
    category: '📢 Админские команды',
    adminOnly: true,
    showInMenu: false, // Не показываем в публичном меню
    showInHelp: true,  // Но показываем в /help для админов
    handler: postCommand, // Использует bot
    canAccess: (ctx: BotContext) => {
      const isPrivateChat = ctx.chat?.type === 'private';
      return ctx.from ? canUsePost(ctx.from.id) && isPrivateChat : false;
    }
  }
];

/**
 * Проверяет, может ли пользователь видеть/использовать команду
 */
export function canAccessCommand(cmd: BotCommand, ctx: BotContext): boolean {
  // Проверяем кастомный доступ
  if (cmd.canAccess && !cmd.canAccess(ctx)) return false;
  
  // Проверяем админские команды
  if (cmd.adminOnly && (!ctx.from || !canUsePost(ctx.from.id))) return false;
  
  return true;
}

/**
 * Общий фильтр для команд (используется и в help, и в menu)
 */
function shouldShowCommand(cmd: BotCommand, ctx?: BotContext, forMenu: boolean = false): boolean {
  // Для меню: только команды с showInMenu
  if (forMenu) {
    if (cmd.showInMenu !== true) return false;
    if (cmd.adminOnly) return false; // Админские команды не в публичном меню
    return true;
  }
  
  // Для help: только команды с showInHelp
  if (cmd.showInHelp !== true) return false;
  
  // Проверяем доступ (если есть контекст)
  if (ctx && !canAccessCommand(cmd, ctx)) return false;
  
  return true;
}

/**
 * Генерирует автоматический /help хендлер на основе реестра команд
 */
function generateHelpHandler(ctx: BotContext, bot: Telegraf<BotContext>): void {
  if (!ctx.from) {
    ctx.reply('❌ Не удалось получить информацию о пользователе.');
    return;
  }

  // Фильтруем команды, которые доступны текущему пользователю
  const availableCommands = commands.filter(cmd => shouldShowCommand(cmd, ctx, false));

  // Группируем команды по категориям
  const categorized = new Map<string, BotCommand[]>();
  
  for (const cmd of availableCommands) {
    const category = cmd.category || '📋 Прочее';
    if (!categorized.has(category)) {
      categorized.set(category, []);
    }
    categorized.get(category)!.push(cmd);
  }

  // Формируем текст помощи
  let helpText = '';
  
  for (const [category, cmds] of categorized) {
    helpText += `\n${category}:\n`;
    for (const cmd of cmds) {
      helpText += `/${cmd.name} - ${cmd.description}\n`;
    }
  }

  ctx.reply(helpText.trim());
}

/**
 * Получить команды для меню Telegram (setMyCommands)
 * Использует тот же фильтр, что и help
 */
export function getMenuCommands(): Array<{ command: string; description: string }> {
  return commands
    .filter(cmd => shouldShowCommand(cmd, undefined, true))
    .map(cmd => ({
      command: cmd.name,
      description: cmd.description
    }));
}
