export type MessageType = 'announcement' | 'message';

export type CommandColor = 'primary' | 'blue' | 'green' | 'orange' | 'purple';

export interface CustomCommand {
  id: string;
  trigger: string;
  aliases: string[];
  response: string;
  enabled: boolean;
  cooldown: number;
  messageType: MessageType;
  color: CommandColor;
  description: string;
}

export interface CommandsData {
  commands: CustomCommand[];
}

export interface LinksConfig {
  allLinksText: string;
}

