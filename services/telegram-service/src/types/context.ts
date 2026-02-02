import { Context } from 'telegraf';
import { PlayersStorage } from '../services/PlayersStorage';
import { DickService } from '../domain/dick/DickService';
import { AppConfig } from './config';

/**
 * Сервисы приложения (DI контейнер)
 */
export interface AppServices {
  players: PlayersStorage;
  dick: DickService;
}

/**
 * Расширенный контекст бота с DI
 */
export interface BotContext extends Context {
  services: AppServices;
  config: AppConfig;
}
