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
  streamerUsername?: string; // Username стримера для особой механики в играх
  nodeEnv: string;
  isLocal: boolean;
}
