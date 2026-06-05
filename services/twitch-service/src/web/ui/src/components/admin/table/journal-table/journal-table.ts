// @ts-ignore
import template from './journal-table.html?raw';
import './journal-table.scss';
import { showAlert } from '../../../../alerts';
import { fetchAdminJournal, fetchJournal } from '../../../../api';
import type { JournalEntry, JournalResponse } from '../../../../types';
import { getAdminPassword } from '../../../../admin-auth';

function formatJournalDate(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString('ru-RU', { month: 'short' });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const hours = d.getHours();
  const isNight = hours >= 0 && hours < 5;
  const suffix = isNight ? ' утра' : '';
  return `${day} ${month}, ${time}${suffix}`;
}

export class JournalTableElement extends HTMLElement {
  private initialized = false;
  private currentPage = 1;
  private currentLimit = 25;
  private currentSearch = '';
  private currentType = '';
  private currentDays = 7;
  private currentFilterDate = '';
  private lastResponse: JournalResponse | null = null;
  private isLoading = false;
  private source: 'event' | 'admin' = 'event';
  private openEventName = 'admin-logs-open';

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.source = this.getAttribute('data-source') === 'admin' ? 'admin' : 'event';
    this.openEventName = this.getAttribute('data-open-event') || 'admin-logs-open';
    const title = this.getAttribute('data-title');
    const description = this.getAttribute('data-description');
    if (title) {
      const h3 = this.querySelector<HTMLElement>('.journal-table-header h3');
      if (h3) h3.textContent = title;
    }
    if (description) {
      const desc = this.querySelector<HTMLElement>('.journal-description');
      if (desc) desc.textContent = description;
    }
    if (this.source === 'admin') {
      const typeFilter = this.querySelector<HTMLElement>('#journal-type-filter');
      if (typeFilter) typeFilter.style.display = 'none';
    }
    this.setupHandlers();
    if (getAdminPassword()) void this.loadJournal();
    window.addEventListener('admin-auth-success', this.handleAuthSuccess);
    window.addEventListener(this.openEventName, this.handleLogsOpen);
  }

  disconnectedCallback(): void {
    window.removeEventListener('admin-auth-success', this.handleAuthSuccess);
    window.removeEventListener(this.openEventName, this.handleLogsOpen);
  }

  private handleAuthSuccess = (): void => {
    void this.loadJournal();
  };

  private handleLogsOpen = (): void => {
    if (!getAdminPassword()) return;
    // При каждом заходе на вкладку логов хотим видеть новые записи первыми.
    this.currentPage = 1;
    void this.loadJournal();
  };

  private renderItems(data: JournalResponse): void {
    const container = this.querySelector<HTMLElement>('#journal-container');
    const table = this.querySelector<HTMLTableElement>('#journal-table');
    const tbody = this.querySelector<HTMLTableSectionElement>('#journal-tbody');
    const emptyState = this.querySelector<HTMLElement>('#journal-empty-state');
    const pagination = this.querySelector<HTMLElement>('#journal-pagination');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');

    if (!container || !table || !tbody || !emptyState || !pagination) return;

    container.classList.remove('loading-state');
    if (loadingEl) loadingEl.style.display = 'none';

    tbody.innerHTML = '';
    this.lastResponse = data;

    if (data.items.length === 0) {
      table.style.display = 'none';
      pagination.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    table.style.display = 'table';
    emptyState.style.display = 'none';
    pagination.style.display = 'flex';

    data.items.forEach((entry: JournalEntry) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="col-message">
          <div class="message-stack">
            <p class="message-stack-row">
              <span class="user-name" data-truncate="end">${escapeHtml(entry.username)}</span>
              <span class="user-timestamp">${escapeHtml(formatJournalDate(entry.createdAt))}</span>
            </p>
            <p class="user-message">${escapeHtml(entry.message)}</p>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    this.updatePagination(data);
  }

  private updatePagination(data: JournalResponse): void {
    const pageInfo = this.querySelector<HTMLElement>('#journal-page-info');
    const prevBtn = this.querySelector<HTMLButtonElement>('#journal-prev-btn');
    const nextBtn = this.querySelector<HTMLButtonElement>('#journal-next-btn');
    const limitSelect = this.querySelector<HTMLSelectElement>('#journal-limit-select');

    if (pageInfo) {
      const pages = Math.max(1, data.pagination.totalPages);
      const total = data.pagination.total;
      pageInfo.textContent =
        total > 0
          ? `Страница ${data.pagination.page} из ${pages} (${total.toLocaleString('ru-RU')} записей)`
          : `Страница ${data.pagination.page} из ${pages}`;
    }
    if (prevBtn) {
      prevBtn.disabled = data.pagination.page <= 1;
    }
    if (nextBtn) {
      nextBtn.disabled = data.pagination.page >= data.pagination.totalPages;
    }
    if (limitSelect) {
      limitSelect.value = String(this.currentLimit);
    }

    const desc = this.querySelector<HTMLElement>('.journal-description');
  }

  async loadJournal(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    const container = this.querySelector<HTMLElement>('#journal-container');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');
    if (container) container.classList.add('loading-state');
    if (loadingEl) loadingEl.style.display = 'block';

    try {
      const byDate = Boolean(this.currentFilterDate);
      const listParams = {
        page: this.currentPage,
        limit: this.currentLimit,
        search: this.currentSearch || undefined,
        ...(byDate
          ? { date: this.currentFilterDate }
          : { days: this.currentDays }),
      };
      const data = this.source === 'admin'
        ? await fetchAdminJournal(listParams)
        : await fetchJournal({
            ...listParams,
            type: this.currentType || undefined,
          });
      this.renderItems(data);
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки журнала: ${error.message}`, 'error');
      }
      if (container) container.classList.remove('loading-state');
      if (loadingEl) loadingEl.style.display = 'none';
    } finally {
      this.isLoading = false;
    }
  }

  private updateDatePlaceholder(): void {
    const dateInput = this.querySelector<HTMLInputElement>('#journal-filter-date');
    if (dateInput) dateInput.classList.toggle('has-value', Boolean(dateInput.value));
  }

  private syncJournalFilterUi(): void {
    const daysFilter = this.querySelector<HTMLSelectElement>('#journal-days-filter');
    if (daysFilter) daysFilter.disabled = Boolean(this.currentFilterDate);
    this.updateDatePlaceholder();
  }

  private applyFiltersFromInputs(): void {
    const dateInput = this.querySelector<HTMLInputElement>('#journal-filter-date');
    this.currentFilterDate = dateInput?.value?.trim() ?? '';
    this.currentPage = 1;
    this.syncJournalFilterUi();
    void this.loadJournal();
  }

  private resetJournalDate(): void {
    this.currentFilterDate = '';
    const dateInput = this.querySelector<HTMLInputElement>('#journal-filter-date');
    if (dateInput) dateInput.value = '';
    this.currentPage = 1;
    this.syncJournalFilterUi();
    void this.loadJournal();
  }

  private setupHandlers(): void {
    const searchInput = this.querySelector<HTMLInputElement>('#journal-search');
    const typeFilter = this.querySelector<HTMLSelectElement>('#journal-type-filter');
    const daysFilter = this.querySelector<HTMLSelectElement>('#journal-days-filter');
    const dateInput = this.querySelector<HTMLInputElement>('#journal-filter-date');
    const dateResetBtn = this.querySelector<HTMLButtonElement>('#journal-filter-reset');
    const refreshBtn = this.querySelector<HTMLButtonElement>('#journal-refresh-btn');
    const prevBtn = this.querySelector<HTMLButtonElement>('#journal-prev-btn');
    const nextBtn = this.querySelector<HTMLButtonElement>('#journal-next-btn');
    const limitSelect = this.querySelector<HTMLSelectElement>('#journal-limit-select');

    let searchTimeout: ReturnType<typeof setTimeout> | null = null;
    searchInput?.addEventListener('input', () => {
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.currentSearch = searchInput.value.trim();
        this.currentPage = 1;
        void this.loadJournal();
        searchTimeout = null;
      }, 300);
    });

    typeFilter?.addEventListener('change', () => {
      this.currentType = typeFilter.value;
      this.currentPage = 1;
      void this.loadJournal();
    });

    daysFilter?.addEventListener('change', () => {
      const parsed = parseInt(daysFilter.value, 10);
      this.currentDays = Number.isFinite(parsed) ? parsed : 7;
      this.currentPage = 1;
      void this.loadJournal();
    });

    dateInput?.addEventListener('change', () => this.applyFiltersFromInputs());
    dateResetBtn?.addEventListener('click', () => this.resetJournalDate());

    refreshBtn?.addEventListener('click', () => void this.loadJournal());

    this.syncJournalFilterUi();

    prevBtn?.addEventListener('click', () => {
      if (this.currentPage > 1) {
        this.currentPage--;
        void this.loadJournal();
      }
    });

    nextBtn?.addEventListener('click', () => {
      if (this.lastResponse && this.currentPage < this.lastResponse.pagination.totalPages) {
        this.currentPage++;
        void this.loadJournal();
      }
    });

    limitSelect?.addEventListener('change', () => {
      this.currentLimit = parseInt(limitSelect.value, 10) || 25;
      this.currentPage = 1;
      void this.loadJournal();
    });
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

declare global {
  interface HTMLElementTagNameMap {
    'journal-table': JournalTableElement;
  }
}

customElements.define('journal-table', JournalTableElement);
