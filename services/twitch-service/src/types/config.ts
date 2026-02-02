/**
 * Конфигурация приложения
 */
export interface AppConfig {
  telegram: {
    token: string;
    channelId?: string;
  };
  twitch: {
    channel: string;
    clientId: string;
    accessToken: string;
    refreshToken?: string;
  };
  allowedAdmins: number[];
  nodeEnv: string;
  isLocal: boolean;
}
