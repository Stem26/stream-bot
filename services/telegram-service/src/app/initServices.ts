import { AppServices } from '../types/context';
import { AppConfig } from '../types/config';
import { PlayersStorage } from '../services/PlayersStorage';
import { DickService } from '../domain/dick/DickService';

/**
 * Инициализирует все сервисы приложения
 */
export function initServices(config: AppConfig): AppServices {
  console.log('🔧 Инициализация сервисов...');
  
  const players = new PlayersStorage();
  const dick = new DickService(players, config.streamerUserId);
  
  if (config.streamerUserId) {
    console.log(`🎮 Стример ID: ${config.streamerUserId} - защита активирована`);
  }
  
  console.log('✅ Сервисы инициализированы');
  
  return {
    players,
    dick
  };
}
