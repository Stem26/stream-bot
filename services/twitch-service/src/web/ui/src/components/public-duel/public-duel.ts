import template from './public-duel.html?raw';
import './public-duel.scss';
import chevronIcon from '../../icons/24px_chevron_left.svg?raw';

interface LeaderboardPlayer {
  twitch_username: string;
  points: number;
  duel_wins: number;
  duel_losses: number;
  duel_draws: number;
}

interface LeaderboardResponse {
  players: LeaderboardPlayer[];
  pagination: {
    total: number;
    totalPages: number;
    page: number;
    limit: number;
  };
}

export class PublicDuelElement extends HTMLElement {
  private initialized = false;
  private currentPage = 1;
  private pageSize = 50;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    
    // Вставляем SVG иконку
    const backBtn = this.querySelector('.back-btn');
    if (backBtn) {
      backBtn.innerHTML = chevronIcon;
    }
    
    this.loadLeaderboard();
  }

  private async loadLeaderboard(): Promise<void> {
    const container = this.querySelector<HTMLDivElement>('#leaderboard-table');
    if (!container) return;

    try {
      const response = await fetch(
        `/api/leaderboard?page=${this.currentPage}&limit=${this.pageSize}`,
      );
      const data: LeaderboardResponse = await response.json();

      if (!data.players || data.players.length === 0) {
        container.className = 'empty-message';
        container.innerHTML = 'Пока нет участников дуэлей';
        return;
      }

      container.className = 'leaderboard-table';
      container.innerHTML = `
        <table>
          <thead>
            <tr>
              <th class="rank-col">#</th>
              <th class="name-col">Участник</th>
              <th class="size-col">Размер</th>
              <th class="stats-col">Статистика дуэлей</th>
            </tr>
          </thead>
          <tbody>
            ${data.players
              .map(
                (p, idx) => `
              <tr>
                <td class="rank">${(this.currentPage - 1) * this.pageSize + idx + 1}</td>
                <td class="name">${this.escapeHtml(p.twitch_username)}</td>
                <td class="size">${p.points || 0} см</td>
                <td class="stats">Побед: ${p.duel_wins || 0} | Проигрышей: ${p.duel_losses || 0} | Ничьих: ${p.duel_draws || 0}</td>
              </tr>
            `,
              )
              .join('')}
          </tbody>
        </table>
        ${this.renderPagination(data.pagination)}
      `;

      this.setupPaginationHandlers();
    } catch (error) {
      console.error('Failed to load leaderboard:', error);
      container.className = 'empty-message';
      container.innerHTML = 'Ошибка загрузки данных';
    }
  }

  private renderPagination(pagination: LeaderboardResponse['pagination']): string {
    const { page, totalPages } = pagination;
    if (totalPages <= 1) return '';

    return `
      <div class="pagination">
        <button class="pagination-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>
          ← Назад
        </button>
        <span class="pagination-info">
          Страница ${page} из ${totalPages}
        </span>
        <button class="pagination-btn" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>
          Вперёд →
        </button>
      </div>
    `;
  }

  private setupPaginationHandlers(): void {
    this.querySelectorAll<HTMLButtonElement>('.pagination-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = parseInt(btn.dataset.page || '1', 10);
        this.currentPage = page;
        this.loadLeaderboard();
      });
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'public-duel': PublicDuelElement;
  }
}

customElements.define('public-duel', PublicDuelElement);
