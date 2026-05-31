import {
  ChannelType,
  Client,
  GatewayIntentBits,
  GatewayOpcodes,
  Guild,
  GuildMember,
  VoiceBasedChannel,
  VoiceState,
} from 'discord.js';
import type { Logger } from 'pino';
import { AppConfig } from '../types/config';

interface VoiceTransition {
  event: 'voice-join' | 'voice-leave' | 'voice-move' | 'voice-target-enter' | 'voice-target-leave';
  fromChannelId: string | null;
  fromChannelName: string | null;
  toChannelId: string | null;
  toChannelName: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
}

export class VoiceChannelGuard {
  private readonly client: Client;
  private readonly logger: Logger;
  private readonly config: AppConfig;
  private readonly processStartedAt = Date.now();
  private checkTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectScheduled = false;
  private isStopping = false;
  private sessionStartedAt: number | null = null;
  private lastStatusLogAt = 0;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ service: 'VoiceChannelGuard' });
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
  }

  async start(): Promise<void> {
    this.logger.info(
      {
        pid: process.pid,
        nodeEnv: this.config.nodeEnv,
        guildId: this.config.guildId,
        voiceChannelId: this.config.voiceChannelId,
        leaveOnStop: this.config.leaveOnStop,
      },
      'Процесс Discord guard запущен',
    );

    this.registerClientHandlers();
    await this.client.login(this.config.botToken);
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    this.clearTimers();

    const sessionDurationSec = this.getSessionDurationSec();
    this.logger.warn(
      {
        signal: 'process-stop',
        sessionDurationSec,
        leaveOnStop: this.config.leaveOnStop,
        uptimeSec: this.getProcessUptimeSec(),
      },
      'Останавливаем Discord guard',
    );

    if (this.config.leaveOnStop) {
      const guild = this.client.guilds.cache.get(this.config.guildId);
      if (guild && guild.members.me && guild.members.me.voice.channelId) {
        this.logger.warn(
          {
            channelId: guild.members.me.voice.channelId,
            sessionDurationSec,
          },
          'Бот отключается от голосового канала из-за остановки процесса',
        );
        this.sendVoiceStateUpdate(guild, null, false, false);
      }
    } else {
      this.logger.info('Бот остаётся в голосовом канале (DISCORD_GUARD_LEAVE_ON_STOP=false)');
    }

    this.client.removeAllListeners();
    await this.client.destroy();
  }

  private registerClientHandlers(): void {
    this.client.once('ready', () => {
      const userTag = this.client.user ? this.client.user.tag : 'unknown';
      const visibleGuilds = [...this.client.guilds.cache.values()].map((guild) => ({
        id: guild.id,
        name: guild.name,
      }));

      this.logger.info(
        {
          userTag,
          guildCount: visibleGuilds.length,
          visibleGuilds,
          configuredGuildId: this.config.guildId,
        },
        'Discord бот готов',
      );

      if (visibleGuilds.length === 0) {
        this.logger.error(
          {
            configuredGuildId: this.config.guildId,
            hint:
              'Бот ни на одном сервере. Developer Portal → OAuth2 → URL Generator → scope bot → пригласите на сервер. DISCORD_GUILD_ID = ПКМ по иконке сервера в Discord, не Application ID из портала.',
          },
          'Нужно пригласить бота на Discord-сервер',
        );
      } else if (!this.client.guilds.cache.has(this.config.guildId)) {
        this.logger.error(
          {
            configuredGuildId: this.config.guildId,
            visibleGuilds,
            hint: 'DISCORD_GUILD_ID не совпадает ни с одним сервером, где есть бот. Скопируйте id из списка visibleGuilds.',
          },
          'Неверный DISCORD_GUILD_ID в .env',
        );
      }

      void this.ensureInVoiceChannel('startup');
      this.startHealthCheck();
    });

    this.client.on('error', (error) => {
      this.logger.error({ err: error }, 'Ошибка Discord клиента');
    });

    this.client.on('shardDisconnect', (event, shardId) => {
      this.logger.warn(
        {
          shardId,
          code: event.code,
          reason: event.reason,
          sessionDurationSec: this.getSessionDurationSec(),
        },
        'Discord shard отключился',
      );
    });

    this.client.on('shardReconnecting', (shardId) => {
      this.logger.warn({ shardId }, 'Discord shard переподключается');
    });

    this.client.on('shardResume', (shardId, replayedEvents) => {
      this.logger.info({ shardId, replayedEvents }, 'Discord shard восстановил сессию');
    });

    this.client.on('voiceStateUpdate', (oldState, newState) => {
      if (!this.client.user) {
        return;
      }

      if (newState.id !== this.client.user.id) {
        return;
      }

      const transition = this.describeVoiceTransition(oldState, newState);
      this.logger.info(
        {
          ...transition,
          sessionDurationSec: this.getSessionDurationSec(),
        },
        this.getVoiceTransitionMessage(transition),
      );

      if (newState.channelId === this.config.voiceChannelId) {
        if (oldState.channelId !== this.config.voiceChannelId) {
          this.sessionStartedAt = Date.now();
          this.logger.info(
            {
              channelId: newState.channelId,
              channelName: transition.toChannelName,
            },
            'Начата сессия в целевом голосовом канале',
          );
        }
        return;
      }

      if (this.isStopping) {
        return;
      }

      if (oldState.channelId === this.config.voiceChannelId) {
        const endedSessionSec = this.getSessionDurationSec();
        this.sessionStartedAt = null;
        this.logger.warn(
          {
            fromChannelId: oldState.channelId,
            fromChannelName: transition.fromChannelName,
            toChannelId: newState.channelId,
            toChannelName: transition.toChannelName,
            endedSessionSec,
          },
          'Бот покинул целевой голосовой канал',
        );
      }

      this.scheduleReconnect('voice-state-update');
    });
  }

  private startHealthCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }

    this.checkTimer = setInterval(() => {
      void this.ensureInVoiceChannel('health-check');
    }, this.config.checkIntervalMs);
  }

  private clearTimers(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectScheduled = false;
  }

  private scheduleReconnect(reason: string): void {
    if (this.isStopping || this.reconnectScheduled) {
      return;
    }

    this.reconnectScheduled = true;
    this.logger.info(
      {
        reason,
        delayMs: this.config.reconnectDelayMs,
        sessionDurationSec: this.getSessionDurationSec(),
      },
      'Запланировано переподключение к голосовому каналу',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectScheduled = false;
      this.reconnectTimer = null;
      void this.ensureInVoiceChannel(reason);
    }, this.config.reconnectDelayMs);
  }

  private async ensureInVoiceChannel(reason: string): Promise<void> {
    if (this.isStopping || !this.client.isReady()) {
      return;
    }

    const guild = await this.getGuild();
    if (!guild) {
      this.logger.error({ guildId: this.config.guildId }, 'Сервер Discord не найден');
      this.scheduleReconnect('guild-not-found');
      return;
    }

    const channel = await this.getVoiceChannel(guild);
    if (!channel) {
      await this.logChannelDiagnostics(guild);
      this.logger.error(
        {
          guildId: guild.id,
          guildName: guild.name,
          voiceChannelId: this.config.voiceChannelId,
        },
        'Голосовой канал не найден',
      );
      this.scheduleReconnect('channel-not-found');
      return;
    }

    const member = await this.getBotMember(guild);
    if (!member) {
      this.logger.error({ guildId: guild.id }, 'Участник бота не найден на сервере');
      this.scheduleReconnect('member-not-found');
      return;
    }

    if (member.voice.channelId === channel.id) {
      if (!this.sessionStartedAt) {
        this.sessionStartedAt = Date.now();
        this.logger.info(
          {
            reason,
            channelId: channel.id,
            channelName: channel.name,
          },
          'Бот уже был в целевом канале до старта текущего процесса',
        );
      }

      this.logPeriodicStatus(reason, channel.name);
      return;
    }

    try {
      this.sendVoiceStateUpdate(guild, channel.id, true, true);

      this.logger.info(
        {
          reason,
          guildName: guild.name,
          channelName: channel.name,
          channelId: channel.id,
          previousChannelId: member.voice.channelId,
        },
        'Отправлен запрос на подключение к голосовому каналу',
      );
    } catch (error) {
      this.logger.error({ err: error, reason }, 'Не удалось подключиться к голосовому каналу');
      this.scheduleReconnect('join-failed');
    }
  }

  private logPeriodicStatus(reason: string, channelName: string): void {
    if (reason !== 'health-check') {
      return;
    }

    const now = Date.now();
    if (now - this.lastStatusLogAt < this.config.statusLogIntervalMs) {
      return;
    }

    this.lastStatusLogAt = now;
    this.logger.info(
      {
        reason,
        channelName,
        sessionDurationSec: this.getSessionDurationSec(),
        uptimeSec: this.getProcessUptimeSec(),
      },
      'Бот продолжает сидеть в целевом голосовом канале',
    );
  }

  private describeVoiceTransition(oldState: VoiceState, newState: VoiceState): VoiceTransition {
    const fromChannelId = oldState.channelId;
    const toChannelId = newState.channelId;
    let event: VoiceTransition['event'] = 'voice-move';

    if (!fromChannelId && toChannelId) {
      event = 'voice-join';
    } else if (fromChannelId && !toChannelId) {
      event = 'voice-leave';
    }

    if (toChannelId === this.config.voiceChannelId) {
      event = 'voice-target-enter';
    } else if (fromChannelId === this.config.voiceChannelId) {
      event = 'voice-target-leave';
    }

    return {
      event,
      fromChannelId,
      fromChannelName: oldState.channel ? oldState.channel.name : null,
      toChannelId,
      toChannelName: newState.channel ? newState.channel.name : null,
      selfMute: newState.selfMute === true,
      selfDeaf: newState.selfDeaf === true,
      serverMute: newState.serverMute === true,
      serverDeaf: newState.serverDeaf === true,
    };
  }

  private getVoiceTransitionMessage(transition: VoiceTransition): string {
    if (transition.event === 'voice-target-enter') {
      return 'Бот вошёл в целевой голосовой канал';
    }

    if (transition.event === 'voice-target-leave') {
      return 'Бот вышел из целевого голосового канала';
    }

    if (transition.event === 'voice-leave') {
      return 'Бот полностью отключился от голосовых каналов';
    }

    if (transition.event === 'voice-join') {
      return 'Бот подключился к голосовому каналу';
    }

    return 'Бот перемещён между голосовыми каналами';
  }

  private getSessionDurationSec(): number | null {
    if (!this.sessionStartedAt) {
      return null;
    }

    return Math.floor((Date.now() - this.sessionStartedAt) / 1000);
  }

  private getProcessUptimeSec(): number {
    return Math.floor((Date.now() - this.processStartedAt) / 1000);
  }

  private sendVoiceStateUpdate(
    guild: Guild,
    channelId: string | null,
    selfMute: boolean,
    selfDeaf: boolean,
  ): void {
    guild.shard.send({
      op: GatewayOpcodes.VoiceStateUpdate,
      d: {
        guild_id: guild.id,
        channel_id: channelId,
        self_mute: selfMute,
        self_deaf: selfDeaf,
      },
    });
  }

  private async getBotMember(guild: Guild): Promise<GuildMember | null> {
    if (guild.members.me) {
      return guild.members.me;
    }

    try {
      return await guild.members.fetchMe();
    } catch (error) {
      this.logger.error({ err: error }, 'Не удалось получить участника бота');
      return null;
    }
  }

  private async getGuild(): Promise<Guild | null> {
    const cachedGuild = this.client.guilds.cache.get(this.config.guildId);
    if (cachedGuild) {
      return cachedGuild;
    }

    try {
      return await this.client.guilds.fetch(this.config.guildId);
    } catch (error) {
      this.logger.error({ err: error }, 'Не удалось получить сервер Discord');
      return null;
    }
  }

  private async getVoiceChannel(guild: Guild): Promise<VoiceBasedChannel | null> {
    const cachedChannel = guild.channels.cache.get(this.config.voiceChannelId);
    if (cachedChannel && cachedChannel.isVoiceBased()) {
      return cachedChannel;
    }

    if (cachedChannel && !cachedChannel.isVoiceBased()) {
      this.logger.error(
        {
          channelId: cachedChannel.id,
          channelName: cachedChannel.name,
          channelType: ChannelType[cachedChannel.type],
        },
        'Указанный ID канала не является голосовым',
      );
      return null;
    }

    try {
      const fetchedChannel = await guild.channels.fetch(this.config.voiceChannelId);
      if (fetchedChannel && fetchedChannel.isVoiceBased()) {
        return fetchedChannel;
      }

      if (fetchedChannel) {
        this.logger.error(
          {
            channelId: fetchedChannel.id,
            channelName: fetchedChannel.name,
            channelType: ChannelType[fetchedChannel.type],
          },
          'Указанный ID канала не является голосовым',
        );
      }
    } catch (error) {
      this.logger.error(
        {
          err: error,
          guildId: guild.id,
          guildName: guild.name,
          voiceChannelId: this.config.voiceChannelId,
        },
        'Не удалось получить голосовой канал (проверьте ID и права View Channel)',
      );
    }

    return null;
  }

  private async logChannelDiagnostics(guild: Guild): Promise<void> {
    try {
      await guild.channels.fetch();
    } catch (error) {
      this.logger.warn({ err: error }, 'Не удалось загрузить список каналов сервера');
    }

    const visibleVoiceChannels = guild.channels.cache
      .filter((channel) => channel.isVoiceBased())
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
      }));

    this.logger.warn(
      {
        guildId: guild.id,
        guildName: guild.name,
        targetChannelId: this.config.voiceChannelId,
        visibleVoiceChannels,
      },
      'Диагностика: голосовые каналы, которые бот видит на сервере',
    );
  }
}
