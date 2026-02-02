import { loadTwitchPlayers } from '../storage/twitch-players';

/**
 * Команда для отображения топа Twitch игроков
 * @returns строка с топом для отправки в чат
 */
export function processTwitchTopDickCommand(): string {
    const players = loadTwitchPlayers();

    if (players.size === 0) {
        return 'Пока никто не играл в !dick на Twitch.';
    }

    const sortedPlayers = Array.from(players.values())
        .sort((a, b) => b.size - a.size)
        .slice(0, 10);

    let response = '🏆 ТОП 10 ПИСЮНОВ НА TWITCH:';

    sortedPlayers.forEach((player, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
        response += ` | ${medal} @${player.twitchUsername} - ${player.size} см`;
    });

    return response;
}
