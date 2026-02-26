/**
 * Конфигурация приложения
 */
export interface AppConfig {
  telegram: {
    token: string;
    channelId?: string;
    chatId?: string;
  };
  twitch: {
    channel: string;
    clientId: string;
    accessToken: string;
    refreshToken?: string;
  };
  allowedAdmins: number[];
  streamerUsername?: string;
  nodeEnv: string;
  isLocal: boolean;
}
