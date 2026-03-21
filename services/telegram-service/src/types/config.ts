/**
 * Конфигурация приложения
 */
export interface AppConfig {
  botToken: string;
  channelId?: string;
  allowedAdmins: number[];
  streamerUserIds: number[];
  nodeEnv: string;
  isLocal: boolean;
}
