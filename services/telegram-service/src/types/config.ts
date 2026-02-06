/**
 * Конфигурация приложения
 */
export interface AppConfig {
  botToken: string;
  channelId?: string;
  allowedAdmins: number[];
  streamerUserId?: number; // ID стримера для особой механики в играх
  nodeEnv: string;
  isLocal: boolean;
}
