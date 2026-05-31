export interface AppConfig {
  botToken: string;
  guildId: string;
  voiceChannelId: string;
  checkIntervalMs: number;
  reconnectDelayMs: number;
  statusLogIntervalMs: number;
  leaveOnStop: boolean;
  nodeEnv: string;
  isLocal: boolean;
}