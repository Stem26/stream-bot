// @ts-ignore
import template from './public-duel.html?raw';
import './public-duel.scss';
import type {LeaderboardResponse} from '../../interfaces/leaderboard';

const MEDALS = ['🥇', '🥈', '🥉'];

export class PublicDuelElement extends HTMLElement {
    private initialized = false;
    private currentPage = 1;
    private pageSize = 50;

    connectedCallback(): void {
        if (this.initialized) return;
        this.initialized = true;
        this.innerHTML = template;
        this.loadLeaderboard().catch((err) => console.error(err));
    }

    private getTemplate(id: string): HTMLTemplateElement {
        return this.querySelector<HTMLTemplateElement>(`#${id}`);
    }

    private async loadLeaderboard(): Promise<void> {
        const container = this.querySelector<HTMLDivElement>('#leaderboard-table');
        if (!container) {
            return;
        }

        try {
            const response = await fetch(
                `/api/leaderboard?page=${this.currentPage}&limit=${this.pageSize}`,
                );
            const data: LeaderboardResponse = await response.json();

            if (!data.players || data.players.length === 0) {
                this.renderEmpty(container);

                return;
            }

            container.className = 'leaderboard-table';
            container.innerHTML = '';
            this.renderLeaderboard(container, data);
            this.setupPaginationHandlers();
        } catch (error) {
            console.error('Failed to load leaderboard:', error);
            this.renderError(container);
        }
    }

    private renderEmpty(container: HTMLDivElement): void {
        const tpl = this.getTemplate('template-empty');
        if (!tpl) {
            return;
        }

        container.className = 'empty-message';
        container.innerHTML = '';
        container.appendChild(tpl.content.cloneNode(true));
    }

    private renderError(container: HTMLDivElement): void {
        const tpl = this.getTemplate('template-error');
        if (!tpl) {
            return;
        }

        container.className = 'empty-message';
        container.innerHTML = '';
        container.appendChild(tpl.content.cloneNode(true));
    }

    private renderLeaderboard(container: HTMLDivElement, data: LeaderboardResponse): void {
        const tpl = this.getTemplate('template-leaderboard');
        if (!tpl) {
            return;
        }

        const frag = tpl.content.cloneNode(true) as DocumentFragment;
        const streamerSlot = frag.querySelector<HTMLDivElement>('.streamer-slot');
        const tbody = frag.querySelector('tbody');
        const paginationSlot = frag.querySelector<HTMLDivElement>('.pagination-slot');

        if (data.streamerPlayer && streamerSlot) {
            const rowTpl = this.getTemplate('template-streamer-row');
            if (rowTpl) {
                const row = rowTpl.content.cloneNode(true) as DocumentFragment;
                const p = data.streamerPlayer!;
                const name = row.querySelector('.streamer-name');
                const stats = row.querySelector('.streamer-stats');
                if (name) name.textContent = p.twitch_username;
                if (stats) stats.textContent = `${p.points || 0} очков · Побед: ${p.duel_wins || 0} | Проигрышей: ${p.duel_losses || 0} | Ничьих: ${p.duel_draws || 0}`;
                streamerSlot.appendChild(row);
            }
        }

        if (tbody) {
            const rowTpl = this.getTemplate('template-player-row');
            if (rowTpl) {
                data.players.forEach((p, idx) => {
                    const rank = (this.currentPage - 1) * this.pageSize + idx + 1;
                    const rankDisplay = rank <= 3 ? MEDALS[rank - 1] : String(rank);
                    const row = rowTpl.content.cloneNode(true) as DocumentFragment;
                    const cells = row.querySelectorAll('td');
                    cells[0].textContent = rankDisplay;
                    cells[1].textContent = p.twitch_username;
                    cells[2].textContent = String(p.points || 0);
                    cells[3].textContent = `Побед: ${p.duel_wins || 0} | Проигрышей: ${p.duel_losses || 0} | Ничьих: ${p.duel_draws || 0}`;
                    tbody.appendChild(row);
                });
            }
        }

        const {page, totalPages} = data.pagination;
        if (totalPages > 1 && paginationSlot) {
            const pagTpl = this.getTemplate('template-pagination');
            if (pagTpl) {
                const pag = pagTpl.content.cloneNode(true) as DocumentFragment;
                pag.querySelector('.pagination-info')!.textContent = `Страница ${page} из ${totalPages}`;
                const prev = pag.querySelector<HTMLButtonElement>('.pagination-prev');
                const next = pag.querySelector<HTMLButtonElement>('.pagination-next');
                if (prev) prev.dataset.page = String(page - 1);
                if (next) next.dataset.page = String(page + 1);
                if (prev) prev.disabled = page === 1;
                if (next) next.disabled = page === totalPages;
                paginationSlot.appendChild(pag);
            }
        }

        container.appendChild(frag);
    }

    private setupPaginationHandlers(): void {
        this.querySelectorAll<HTMLButtonElement>('.pagination-btn[data-page]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.currentPage = parseInt(btn.dataset.page || '1', 10);
                this.loadLeaderboard().catch((err) => console.error(err));
            });
        });
    }
}

customElements.define('public-duel', PublicDuelElement);
