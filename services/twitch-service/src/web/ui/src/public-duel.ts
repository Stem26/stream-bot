import './public-duel.scss';

let currentPage = 1;
const pageSize = 50;

async function loadLeaderboard(page: number = 1): Promise<void> {
  try {
    currentPage = page;
    const response = await fetch(`/api/leaderboard?page=${page}&limit=${pageSize}`);
    const data = await response.json();
    const container = document.getElementById('leaderboard-table');
    
    if (!container) return;

    if (!data.players || data.players.length === 0) {
      container.innerHTML = '<p class="empty-message">Пока нет данных</p>';
      return;
    }

    const { pagination } = data;
    const startRank = (pagination.page - 1) * pagination.limit;

    const tableHTML = `
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Игрок</th>
            <th>Очки</th>
            <th class="stats-col">Статистика</th>
          </tr>
        </thead>
        <tbody>
          ${data.players
            .map(
              (p: any, index: number) => `
            <tr>
              <td class="rank">${startRank + index + 1}</td>
              <td class="username">${p.twitch_username}</td>
              <td class="points">${p.points}</td>
              <td class="stats stats-col">
                Побед: ${p.duel_wins || 0} | Проигрышей: ${p.duel_losses || 0} | Ничьих: ${p.duel_draws || 0}
              </td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
      <div class="pagination">
        <button 
          class="btn" 
          id="prev-page-btn" 
          ${pagination.page <= 1 ? 'disabled' : ''}
        >← Назад</button>
        <span class="pagination-info">
          Страница ${pagination.page} из ${pagination.totalPages} (всего: ${pagination.total})
        </span>
        <button 
          class="btn" 
          id="next-page-btn"
          ${pagination.page >= pagination.totalPages ? 'disabled' : ''}
        >Вперёд →</button>
      </div>
    `;

    container.innerHTML = tableHTML;

    document.getElementById('prev-page-btn')?.addEventListener('click', () => {
      if (currentPage > 1) loadLeaderboard(currentPage - 1);
    });

    document.getElementById('next-page-btn')?.addEventListener('click', () => {
      if (currentPage < pagination.totalPages) loadLeaderboard(currentPage + 1);
    });
  } catch (error) {
    console.error('Ошибка загрузки таблицы лидеров:', error);
  }
}

loadLeaderboard();
