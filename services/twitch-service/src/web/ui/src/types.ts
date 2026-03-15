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
  inRotation: boolean;
}

export interface CommandsData {
  commands: CustomCommand[];
}

export interface LinksConfig {
  allLinksText: string;
  rotationIntervalMinutes: number;
}

export interface Counter {
  id: string;
  trigger: string;
  aliases: string[];
  responseTemplate: string;
  value: number;
  enabled: boolean;
  description: string;
}

export interface CountersData {
  counters: Counter[];
}

export interface PartyItem {
  id: number;
  text: string;
  sort_order: number;
}

export interface PartyItemsData {
  items: PartyItem[];
}

export interface PartyConfig {
  elementsCount: number;
  quantityMax: number;
  skipCooldown: boolean;
}

export interface ChatModerationConfig {
  moderationEnabled: boolean;
  checkSymbols: boolean;
  checkLetters: boolean;
  maxMessageLength: number;
  maxLettersDigits: number;
  timeoutMinutes: number;
}

