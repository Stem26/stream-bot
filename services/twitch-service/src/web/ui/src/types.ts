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

export interface FriendsShoutoutConfig {
  enabled: boolean;
  logins: string[];
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

export interface DonateXDonationItem {
  id: string;
  username: string;
  message: string;
  currency: string;
  amount: string;
  amountInRub: string;
  donatedAt: string;
  isTest: boolean;
  withAiResponse: boolean;
  source: string;
}

export interface DonateXTopDonorItem {
  username: string;
  donationCount: number;
  totalAmountRub: string;
  lastDonationAt: string;
}

export interface DonateXTopDonorsResponse {
  donors: DonateXTopDonorItem[];
}

export interface DonateXDayTopRow {
  streamDate: string;
  streamStart: string | null;
  top1: string | null;
  top1Rub: string | null;
  top2: string | null;
  top2Rub: string | null;
  top3: string | null;
  top3Rub: string | null;
}

export interface DonateXDayTopPointsConfig {
  pointsTop1: number;
  pointsTop2: number;
  pointsTop3: number;
  updatedAt?: string | null;
}

export interface DonateXMonthlyPointsEntry {
  username: string;
  totalPoints: number;
  asTop1: number;
  asTop2: number;
  asTop3: number;
}

export interface DonateXTopByDayResponse {
  timezone: string;
  year: number;
  month: number;
  groupBy?: 'stream' | 'calendar';
  points: { top1: number; top2: number; top3: number };
  monthlyLeaderboard: DonateXMonthlyPointsEntry[];
  cumulativeSince: string;
  cumulativeLeaderboard: DonateXMonthlyPointsEntry[];
  rows: DonateXDayTopRow[];
}

export interface DonateXDonationsResponse {
  items: DonateXDonationItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  stats?: {
    donations: number;
    donors: number;
    lastDonationAt: string | null;
  };
  signalrState?: string;
}

