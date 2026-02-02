/**
 * Конфигурация приложения
 */
export interface AppConfig {
  botToken: string;
  channelId?: string;
  allowedAdmins: number[];
  nodeEnv: string;
  isLocal: boolean;
}
