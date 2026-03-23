export type TwitchEventSubStreamOnlineEvent = {
    broadcaster_user_id: string;
    broadcaster_user_login: string;
    broadcaster_user_name: string;
    started_at: string;
};

export type TwitchEventSubStreamOfflineEvent = Pick<
    TwitchEventSubStreamOnlineEvent,
    'broadcaster_user_login' | 'broadcaster_user_name'
>;
