import { AppServices } from '../types/context';
import { PlayersStorage } from '../services/PlayersStorage';
import { DickService } from '../domain/dick/DickService';

/**
 * Инициализирует все сервисы приложения
 */
export function initServices(): AppServices {
  console.log('🔧 Инициализация сервисов...');
  
  const players = new PlayersStorage();
  const dick = new DickService(players);
  
  console.log('✅ Сервисы инициализированы');
  
  return {
    players,
    dick
  };
}
