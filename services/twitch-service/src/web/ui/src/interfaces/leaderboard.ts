export interface LeaderboardPlayer {
  twitch_username: string;
  points: number;
  duel_wins: number;
  duel_losses: number;
  duel_draws: number;
}

export interface LeaderboardResponse {
  players: LeaderboardPlayer[];
  streamerPlayer: LeaderboardPlayer | null;
  pagination: {
    total: number;
    totalPages: number;
    page: number;
    limit: number;
  };
}
