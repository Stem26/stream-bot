import { TwitchPlayersStorageDB } from '../services/TwitchPlayersStorageDB';

const storage = new TwitchPlayersStorageDB();

/**
 * Команда для отображения топа Twitch игроков
 * @returns строка с топом для отправки в чат
 */
export function processTwitchTopDickCommand(): string {
    const sortedPlayers = storage.getTop(10);

    if (sortedPlayers.length === 0) {
        return 'Пока никто не играл в !dick на Twitch.';
    }

    let response = '🏆 ТОП 10 ПИСЮНОВ НА TWITCH:';

    sortedPlayers.forEach((player, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
        response += ` | ${medal} @${player.twitchUsername} - ${player.size} см`;
    });

    return response;
}
