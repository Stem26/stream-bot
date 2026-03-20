export type MessageType = 'announcement' | 'message';

export type CommandColor = 'primary' | 'blue' | 'green' | 'orange' | 'purple';

export type AccessLevel = 'everyone' | 'moderators';

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
  accessLevel: AccessLevel;
}

export interface CommandsData {
  commands: CustomCommand[];
}

export interface LinksConfig {
  allLinksText: string;
  rotationIntervalMinutes: number;
}

export interface RaidConfig {
  raidMessage: string;
}

export interface Counter {
  id: string;
  trigger: string;
  aliases: string[];
  responseTemplate: string;
  value: number;
  enabled: boolean;
  description: string;
  accessLevel: AccessLevel;
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
  enabled: boolean;
  trigger: string;
  responseText: string;
  elementsCount: number;
  quantityMax: number;
  skipCooldown: boolean;
}

export interface ChatModerationConfig {
  moderationEnabled: boolean;
  checkSymbols: boolean;
  checkLetters: boolean;
  checkLinks: boolean;
  maxMessageLength: number;
  maxLettersDigits: number;
  timeoutMinutes: number;
}

export type JournalEventType = 'message' | 'command' | 'system';

export interface JournalEntry {
  id: number;
  createdAt: string;
  username: string;
  message: string;
  eventType: JournalEventType;
}

export interface JournalResponse {
  items: JournalEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

