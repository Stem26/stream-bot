import { AppServices } from '../types/context';
import { AppConfig } from '../types/config';
import { PlayersStorageDB } from '../services/PlayersStorageDB';
import { DickService } from '../domain/dick/DickService';

/**
 * Инициализирует все сервисы приложения
 */
export function initServices(config: AppConfig): AppServices {
  console.log('🔧 Инициализация сервисов...');
  
  const players = new PlayersStorageDB();
  const dick = new DickService(players, config.streamerUserIds);

  if (config.streamerUserIds.length > 0) {
    console.log(`🎮 Стример ID: ${config.streamerUserIds.join(', ')} — защита активирована`);
  }
  
  console.log('✅ Сервисы инициализированы');
  
  return {
    players,
    dick
  };
}
