import { Player, PlayersStorageDB } from '../services/PlayersStorageDB';

export function emptyPlayer(userId: number, username: string, firstName: string): Player {
  return {
    userId,
    username,
    firstName,
    size: 0,
    lastUsed: 0,
    lastUsedDate: '',
  };
}

export async function getOrCreatePlayer(
  players: PlayersStorageDB,
  userId: number,
  username: string,
  firstName: string,
): Promise<Player> {
  return (await players.get(userId)) ?? emptyPlayer(userId, username, firstName);
}
