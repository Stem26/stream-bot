export type TwitchEventSubStreamOnlineEvent = {
    broadcaster_user_id: string;
    broadcaster_user_login: string;
    broadcaster_user_name: string;
    started_at: string;
};

export type TwitchEventSubStreamOfflineEvent = Pick<
    TwitchEventSubStreamOnlineEvent,
    'broadcaster_user_id' | 'broadcaster_user_login' | 'broadcaster_user_name'
>;

export type TwitchEventSubFollowEvent = {
    user_id: string;
    user_login: string;
    user_name: string;
};

export type TwitchEventSubRaidEvent = {
    from_broadcaster_user_id: string;
    from_broadcaster_user_login: string;
    from_broadcaster_user_name: string;
    viewers?: number;
};

export type EventSubNotification =
    | {
        type: 'stream.online';
        event: TwitchEventSubStreamOnlineEvent;
    }
    | {
        type: 'stream.offline';
        event: TwitchEventSubStreamOfflineEvent;
    }
    | {
        type: 'channel.follow';
        event: TwitchEventSubFollowEvent;
    }
    | {
        type: 'channel.raid';
        event: TwitchEventSubRaidEvent;
    };
