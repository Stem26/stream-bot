// @ts-ignore
import template from './donations-table.html?raw';
import './donations-table.scss';
import { showAlert } from '../../../../alerts';
import {
  fetchDonateXDonations,
  fetchDonateXTopDonors,
  fetchDonateXTopByDay,
  saveDonateXDayTopPoints,
  type DonateXTopSortField,
} from '../../../../api';
import type {
  DonateXDonationItem,
  DonateXDonationsResponse,
  DonateXTopDonorItem,
  DonateXDayTopRow,
  DonateXMonthlyPointsEntry,
  DonateXTopByDayResponse,
} from '../../../../types';
import { getAdminPassword } from '../../../../admin-auth';

type DonationsSubtab = 'all' | 'top' | 'daytop';

function formatStreamDate(isoDate: string): string {
  const dateOnly = isoDate.trim().slice(0, 10);
  const parts = dateOnly.split('-');
  if (parts.length !== 3) return isoDate;
  const [y, m, d] = parts;
  return `${d}.${m}.${y.slice(-2)}`;
}

function formatDayTopStreamLabel(row: DonateXDayTopRow): string {
  return formatStreamDate(row.streamDate);
}

function isExcludedTopUser(username: string | null): boolean {
  if (!username?.trim()) return true;
  const n = username.trim().toLowerCase();
  return n === 'аноним' || n === 'anonymous' || n === 'anon' || n.startsWith('аноним');
}

function formatTopCell(username: string | null, amountRub: string | null): string {
  if (!username || isExcludedTopUser(username)) return '—';
  const amount = amountRub
    ? `<span class="daytop-amount">${escapeHtml(formatAmount(amountRub))} ₽</span>`
    : '';
  return `<span class="daytop-cell"><span class="daytop-name">${escapeHtml(username)}</span>${amount}</span>`;
}

function formatDonationDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function formatAmount(value: string): string {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return value;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

export class DonationsTableElement extends HTMLElement {
  private initialized = false;
  private activeSubtab: DonationsSubtab = 'all';
  private topLoaded = false;
  private currentPage = 1;
  private currentLimit = 25;
  private currentSearch = '';
  private currentDays = 30;
  /** Фильтр «ник + дата»: календарный день (МСК), без days. */
  private currentFilterDate = '';
  private currentFilterUsername = '';
  private hideTest = true;
  private lastResponse: DonateXDonationsResponse | null = null;
  private isLoadingAll = false;
  private isLoadingTop = false;
  private topHideTest = true;
  private topSortBy: DonateXTopSortField = 'sum';
  private topSortDir: 'asc' | 'desc' = 'desc';
  private dayTopLoaded = false;
  private isLoadingDayTop = false;
  private dayTopHideTest = true;
  private dayTopYear = 0;
  private dayTopMonth = 0;
  private dayTopPointsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDayTopResponse: DonateXTopByDayResponse | null = null;

  private getDefaultYearMonth(): { year: number; month: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date());
    return {
      year: parseInt(parts.find((p) => p.type === 'year')?.value ?? '2026', 10),
      month: parseInt(parts.find((p) => p.type === 'month')?.value ?? '1', 10),
    };
  }

  private initDayTopMonthInput(): void {
    const input = this.querySelector<HTMLInputElement>('#donations-daytop-month');
    if (!input) return;
    const { year, month } = this.getDefaultYearMonth();
    if (!this.dayTopYear || !this.dayTopMonth) {
      this.dayTopYear = year;
      this.dayTopMonth = month;
    }
    input.value = `${this.dayTopYear}-${String(this.dayTopMonth).padStart(2, '0')}`;
  }

  private readDayTopMonthFromInput(): void {
    const input = this.querySelector<HTMLInputElement>('#donations-daytop-month');
    if (!input?.value) return;
    const [y, m] = input.value.split('-').map((x) => parseInt(x, 10));
    if (y && m >= 1 && m <= 12) {
      this.dayTopYear = y;
      this.dayTopMonth = m;
    }
  }

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.setupSubtabs();
    this.setupAllHandlers();
    this.setupTopHandlers();
    this.initDayTopMonthInput();
    this.setupDayTopHandlers();
    if (getAdminPassword()) void this.loadActivePanel();
    window.addEventListener('admin-auth-success', this.handleAuthSuccess);
    window.addEventListener('admin-donations-open', this.handleTabOpen);
  }

  disconnectedCallback(): void {
    window.removeEventListener('admin-auth-success', this.handleAuthSuccess);
    window.removeEventListener('admin-donations-open', this.handleTabOpen);
  }

  private handleAuthSuccess = (): void => {
    this.topLoaded = false;
    this.dayTopLoaded = false;
    void this.loadActivePanel();
  };

  private handleTabOpen = (): void => {
    if (!getAdminPassword()) return;
    this.currentPage = 1;
    void this.loadActivePanel();
  };

  private applyDayTopPointsInputs(points: { top1: number; top2: number; top3: number }): void {
    const p1 = this.querySelector<HTMLInputElement>('#donations-daytop-points-1');
    const p2 = this.querySelector<HTMLInputElement>('#donations-daytop-points-2');
    const p3 = this.querySelector<HTMLInputElement>('#donations-daytop-points-3');
    if (p1) p1.value = String(points.top1);
    if (p2) p2.value = String(points.top2);
    if (p3) p3.value = String(points.top3);
  }

  private readDayTopPointsInputs(): { pointsTop1: number; pointsTop2: number; pointsTop3: number } {
    const p1 = this.querySelector<HTMLInputElement>('#donations-daytop-points-1');
    const p2 = this.querySelector<HTMLInputElement>('#donations-daytop-points-2');
    const p3 = this.querySelector<HTMLInputElement>('#donations-daytop-points-3');
    return {
      pointsTop1: Math.max(0, parseInt(p1?.value ?? '3', 10) || 0),
      pointsTop2: Math.max(0, parseInt(p2?.value ?? '2', 10) || 0),
      pointsTop3: Math.max(0, parseInt(p3?.value ?? '1', 10) || 0),
    };
  }

  private setDayTopPointsStatus(text: string): void {
    const el = this.querySelector<HTMLElement>('#donations-daytop-points-status');
    if (el) el.textContent = text;
  }

  private scheduleSaveDayTopPoints(): void {
    if (this.dayTopPointsSaveTimer) clearTimeout(this.dayTopPointsSaveTimer);
    this.setDayTopPointsStatus('Сохранение…');
    this.dayTopPointsSaveTimer = setTimeout(() => {
      this.dayTopPointsSaveTimer = null;
      void this.persistDayTopPoints();
    }, 600);
  }

  private async persistDayTopPoints(): Promise<void> {
    const payload = this.readDayTopPointsInputs();
    try {
      await saveDonateXDayTopPoints(payload);
      this.setDayTopPointsStatus('Сохранено');
      this.dayTopLoaded = false;
      await this.loadDayTop(true);
    } catch (error) {
      this.setDayTopPointsStatus('');
      if (error instanceof Error) {
        showAlert(`Ошибка сохранения баллов: ${error.message}`, 'error');
      }
    }
  }

  private renderPointsLeaderboardHtml(
    entries: DonateXMonthlyPointsEntry[],
    emptyText: string
  ): string {
    if (entries.length === 0) {
      return `<p class="monthly-empty">${escapeHtml(emptyText)}</p>`;
    }
    return `<ol class="monthly-leaderboard">${entries
      .map(
        (e) => `<li class="monthly-entry">
          <span class="monthly-name">${escapeHtml(e.username)}</span>
          <span class="monthly-points">${e.totalPoints} очк.</span>
        </li>`
      )
      .join('')}</ol>`;
  }

  private setupSubtabs(): void {
    const buttons = this.querySelectorAll<HTMLButtonElement>('.donations-subtab-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const subtab = btn.dataset.subtab as DonationsSubtab | undefined;
        if (!subtab || subtab === this.activeSubtab) return;
        this.activeSubtab = subtab;
        buttons.forEach((b) => b.classList.toggle('active', b === btn));
        this.querySelectorAll<HTMLElement>('.donations-subtab-panel').forEach((panel) => {
          panel.classList.toggle('active', panel.id === `donations-panel-${subtab}`);
        });
        void this.loadActivePanel();
      });
    });
  }

  private loadActivePanel(): void {
    if (this.activeSubtab === 'top') {
      void this.loadTopDonors();
    } else if (this.activeSubtab === 'daytop') {
      void this.loadDayTop();
    } else {
      void this.loadDonations();
    }
  }

  private updateSummary(data: DonateXDonationsResponse): void {
    const totalEl = this.querySelector<HTMLElement>('#donations-total-count');
    const signalrEl = this.querySelector<HTMLElement>('#donations-signalr-state');
    if (totalEl) {
      totalEl.textContent = String(data.stats?.donations ?? data.pagination.total);
    }
    if (signalrEl) {
      signalrEl.textContent = data.signalrState ?? '—';
    }
  }

  private renderAllItems(data: DonateXDonationsResponse): void {
    const container = this.querySelector<HTMLElement>('#donations-container');
    const table = this.querySelector<HTMLTableElement>('#donations-table');
    const tbody = this.querySelector<HTMLTableSectionElement>('#donations-tbody');
    const emptyState = this.querySelector<HTMLElement>('#donations-empty-state');
    const pagination = this.querySelector<HTMLElement>('#donations-pagination');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');

    if (!container || !table || !tbody || !emptyState || !pagination) return;

    container.classList.remove('loading-state');
    if (loadingEl) loadingEl.style.display = 'none';

    this.updateSummary(data);
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

    data.items.forEach((row: DonateXDonationItem) => {
      const tr = document.createElement('tr');
      const flags: string[] = [];
      if (row.isTest) flags.push('<span class="donation-flag test">тест</span>');
      if (row.withAiResponse) flags.push('<span class="donation-flag ai">ИИ</span>');

      tr.innerHTML = `
        <td class="col-date">${escapeHtml(formatDonationDate(row.donatedAt))}</td>
        <td class="col-user">${escapeHtml(row.username)}</td>
        <td class="col-amount">${escapeHtml(formatAmount(row.amount))} ${escapeHtml(row.currency)}</td>
        <td class="col-rub">${escapeHtml(formatAmount(row.amountInRub))} ₽</td>
        <td class="col-message" title="${escapeHtml(row.message)}">${escapeHtml(row.message) || '—'}</td>
        <td class="col-flags">${flags.join('') || '—'}</td>
      `;
      tbody.appendChild(tr);
    });

    this.updatePagination(data);
  }

  private updatePagination(data: DonateXDonationsResponse): void {
    const pageInfo = this.querySelector<HTMLElement>('#donations-page-info');
    const prevBtn = this.querySelector<HTMLButtonElement>('#donations-prev-btn');
    const nextBtn = this.querySelector<HTMLButtonElement>('#donations-next-btn');
    const limitSelect = this.querySelector<HTMLSelectElement>('#donations-limit-select');

    if (pageInfo) {
      pageInfo.textContent = `Страница ${data.pagination.page} из ${Math.max(1, data.pagination.totalPages)}`;
    }
    if (prevBtn) prevBtn.disabled = data.pagination.page <= 1;
    if (nextBtn) nextBtn.disabled = data.pagination.page >= data.pagination.totalPages;
    if (limitSelect) limitSelect.value = String(this.currentLimit);
  }

  private syncDayFilterUi(): void {
    const active = Boolean(this.currentFilterDate);
    const daysFilter = this.querySelector<HTMLSelectElement>('#donations-days-filter');
    const searchInput = this.querySelector<HTMLInputElement>('#donations-search');
    const clearBtn = this.querySelector<HTMLButtonElement>('#donations-day-filter-clear');
    const hint = this.querySelector<HTMLElement>('#donations-day-filter-hint');
    const dateInput = this.querySelector<HTMLInputElement>('#donations-filter-date');
    const userInput = this.querySelector<HTMLInputElement>('#donations-filter-username');

    if (daysFilter) daysFilter.disabled = active;
    if (searchInput) searchInput.disabled = active;
    if (clearBtn) clearBtn.style.display = active ? '' : 'none';
    if (dateInput && this.currentFilterDate) dateInput.value = this.currentFilterDate;
    if (userInput) userInput.value = this.currentFilterUsername;
    if (hint) {
      if (!active) {
        hint.style.display = 'none';
        hint.textContent = '';
      } else {
        hint.style.display = '';
        const who = this.currentFilterUsername
          ? `ник «${this.currentFilterUsername}», `
          : '';
        hint.textContent = `${who}день ${formatStreamDate(this.currentFilterDate)} (МСК), без ограничения по периоду`;
      }
    }
  }

  private applyDayFilterFromInputs(): void {
    const dateInput = this.querySelector<HTMLInputElement>('#donations-filter-date');
    const userInput = this.querySelector<HTMLInputElement>('#donations-filter-username');
    const date = dateInput?.value?.trim() ?? '';
    if (!date) {
      showAlert('Укажите дату', 'error');
      return;
    }
    this.currentFilterDate = date;
    this.currentFilterUsername = userInput?.value.trim() ?? '';
    this.currentPage = 1;
    if (this.currentLimit < 100) this.currentLimit = 100;
    const limitSelect = this.querySelector<HTMLSelectElement>('#donations-limit-select');
    if (limitSelect) limitSelect.value = String(this.currentLimit);
    this.syncDayFilterUi();
    void this.loadDonations();
  }

  private clearDayFilter(): void {
    this.currentFilterDate = '';
    this.currentFilterUsername = '';
    this.currentPage = 1;
    const dateInput = this.querySelector<HTMLInputElement>('#donations-filter-date');
    const userInput = this.querySelector<HTMLInputElement>('#donations-filter-username');
    if (dateInput) dateInput.value = '';
    if (userInput) userInput.value = '';
    this.syncDayFilterUi();
    void this.loadDonations();
  }

  async loadDonations(): Promise<void> {
    if (this.isLoadingAll) return;
    this.isLoadingAll = true;
    const container = this.querySelector<HTMLElement>('#donations-container');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');
    if (container) container.classList.add('loading-state');
    if (loadingEl) loadingEl.style.display = 'block';

    try {
      const byDay = Boolean(this.currentFilterDate);
      const data = await fetchDonateXDonations({
        page: this.currentPage,
        limit: this.currentLimit,
        search: byDay ? undefined : this.currentSearch || undefined,
        days: byDay ? undefined : this.currentDays,
        date: byDay ? this.currentFilterDate : undefined,
        username: byDay && this.currentFilterUsername ? this.currentFilterUsername : undefined,
        hideTest: this.hideTest,
      });
      this.renderAllItems(data);
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки донатов: ${error.message}`, 'error');
      }
      if (container) container.classList.remove('loading-state');
      if (loadingEl) loadingEl.style.display = 'none';
    } finally {
      this.isLoadingAll = false;
    }
  }

  private renderTopDonors(donors: DonateXTopDonorItem[]): void {
    const container = this.querySelector<HTMLElement>('#donations-top-container');
    const table = this.querySelector<HTMLTableElement>('#donations-top-table');
    const tbody = this.querySelector<HTMLTableSectionElement>('#donations-top-tbody');
    const emptyState = this.querySelector<HTMLElement>('#donations-top-empty-state');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');

    if (!container || !table || !tbody || !emptyState) return;

    container.classList.remove('loading-state');
    if (loadingEl) loadingEl.style.display = 'none';
    tbody.innerHTML = '';

    if (donors.length === 0) {
      table.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    table.style.display = 'table';
    emptyState.style.display = 'none';

    donors.forEach((row, index) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="col-rank">${index + 1}</td>
        <td class="col-user">${escapeHtml(row.username)}</td>
        <td class="col-rub"><strong>${escapeHtml(formatAmount(row.totalAmountRub))} ₽</strong></td>
        <td class="col-count">${row.donationCount}</td>
        <td class="col-date">${escapeHtml(formatDonationDate(row.lastDonationAt))}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  async loadTopDonors(force = false): Promise<void> {
    if (this.isLoadingTop) return;
    if (this.topLoaded && !force) return;
    this.isLoadingTop = true;

    const container = this.querySelector<HTMLElement>('#donations-top-container');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');
    if (container) container.classList.add('loading-state');
    if (loadingEl) loadingEl.style.display = 'block';

    try {
      const data = await fetchDonateXTopDonors({
        limit: 20,
        hideTest: this.topHideTest,
        sortBy: this.topSortBy,
        sortDir: this.topSortDir,
      });
      this.renderTopDonors(data.donors);
      this.updateTopSortIndicators();
      this.topLoaded = true;
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки топа: ${error.message}`, 'error');
      }
      if (container) container.classList.remove('loading-state');
      if (loadingEl) loadingEl.style.display = 'none';
    } finally {
      this.isLoadingTop = false;
    }
  }

  private setupAllHandlers(): void {
    const searchInput = this.querySelector<HTMLInputElement>('#donations-search');
    const daysFilter = this.querySelector<HTMLSelectElement>('#donations-days-filter');
    const hideTestCheckbox = this.querySelector<HTMLInputElement>('#donations-hide-test');
    const refreshBtn = this.querySelector<HTMLButtonElement>('#donations-refresh-btn');
    const prevBtn = this.querySelector<HTMLButtonElement>('#donations-prev-btn');
    const nextBtn = this.querySelector<HTMLButtonElement>('#donations-next-btn');
    const limitSelect = this.querySelector<HTMLSelectElement>('#donations-limit-select');
    const dayFilterBtn = this.querySelector<HTMLButtonElement>('#donations-day-filter-btn');
    const dayFilterClear = this.querySelector<HTMLButtonElement>('#donations-day-filter-clear');
    const filterDateInput = this.querySelector<HTMLInputElement>('#donations-filter-date');
    const filterUserInput = this.querySelector<HTMLInputElement>('#donations-filter-username');

    dayFilterBtn?.addEventListener('click', () => this.applyDayFilterFromInputs());
    dayFilterClear?.addEventListener('click', () => this.clearDayFilter());
    filterDateInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.applyDayFilterFromInputs();
    });
    filterUserInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.applyDayFilterFromInputs();
    });

    let searchTimeout: ReturnType<typeof setTimeout> | null = null;
    searchInput?.addEventListener('input', () => {
      if (this.currentFilterDate) return;
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.currentSearch = searchInput.value.trim();
        this.currentPage = 1;
        void this.loadDonations();
        searchTimeout = null;
      }, 300);
    });

    daysFilter?.addEventListener('change', () => {
      if (this.currentFilterDate) return;
      this.currentDays = parseInt(daysFilter.value, 10) || 30;
      this.currentPage = 1;
      void this.loadDonations();
    });

    hideTestCheckbox?.addEventListener('change', () => {
      this.hideTest = hideTestCheckbox.checked;
      this.currentPage = 1;
      void this.loadDonations();
    });

    refreshBtn?.addEventListener('click', () => void this.loadDonations());

    prevBtn?.addEventListener('click', () => {
      if (this.currentPage > 1) {
        this.currentPage--;
        void this.loadDonations();
      }
    });

    nextBtn?.addEventListener('click', () => {
      if (this.lastResponse && this.currentPage < this.lastResponse.pagination.totalPages) {
        this.currentPage++;
        void this.loadDonations();
      }
    });

    limitSelect?.addEventListener('change', () => {
      this.currentLimit = parseInt(limitSelect.value, 10) || 25;
      this.currentPage = 1;
      void this.loadDonations();
    });
  }

  private updateTopSortIndicators(): void {
    this.querySelectorAll<HTMLTableCellElement>('.donations-top-table th.sortable').forEach((th) => {
      const field = th.dataset.sort as DonateXTopSortField | undefined;
      const indicator = th.querySelector<HTMLElement>('.sort-indicator');
      const active = field === this.topSortBy;
      th.classList.toggle('sort-active', active);
      if (indicator) {
        indicator.textContent = active ? (this.topSortDir === 'asc' ? '↑' : '↓') : '';
      }
    });
  }

  private renderDayTop(data: DonateXTopByDayResponse): void {
    const container = this.querySelector<HTMLElement>('#donations-daytop-container');
    const layout = this.querySelector<HTMLElement>('#donations-daytop-layout');
    const monthlyBody = this.querySelector<HTMLElement>('#donations-daytop-monthly-body');
    const cumulativeBody = this.querySelector<HTMLElement>('#donations-daytop-cumulative-body');
    const tbody = this.querySelector<HTMLTableSectionElement>('#donations-daytop-tbody');
    const emptyState = this.querySelector<HTMLElement>('#donations-daytop-empty-state');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');
    const rows = data.rows;

    if (!container || !layout || !monthlyBody || !cumulativeBody || !tbody || !emptyState) return;

    container.classList.remove('loading-state');
    if (loadingEl) loadingEl.style.display = 'none';
    tbody.innerHTML = '';

    if (rows.length === 0) {
      layout.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    layout.style.display = 'flex';
    emptyState.style.display = 'none';
    monthlyBody.innerHTML = this.renderPointsLeaderboardHtml(
      data.monthlyLeaderboard,
      'Нет очков за выбранный месяц'
    );
    cumulativeBody.innerHTML = this.renderPointsLeaderboardHtml(
      data.cumulativeLeaderboard,
      'Нет очков с выбранной даты'
    );

    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.className = 'daytop-row';
      tr.innerHTML = `
        <td class="col-stream">${escapeHtml(formatDayTopStreamLabel(row))}</td>
        <td class="col-top-slot col-top-1">${formatTopCell(row.top1, row.top1Rub)}</td>
        <td class="col-top-slot col-top-2">${formatTopCell(row.top2, row.top2Rub)}</td>
        <td class="col-top-slot col-top-3">${formatTopCell(row.top3, row.top3Rub)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  async loadDayTop(force = false): Promise<void> {
    if (this.isLoadingDayTop) return;
    if (this.dayTopLoaded && !force) return;
    this.isLoadingDayTop = true;

    const container = this.querySelector<HTMLElement>('#donations-daytop-container');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');
    if (container) container.classList.add('loading-state');
    if (loadingEl) loadingEl.style.display = 'block';

    try {
      this.readDayTopMonthFromInput();
      const data = await fetchDonateXTopByDay({
        year: this.dayTopYear,
        month: this.dayTopMonth,
        hideTest: this.dayTopHideTest,
      });
      this.applyDayTopPointsInputs(data.points);
      this.lastDayTopResponse = data;
      this.renderDayTop(data);
      this.dayTopLoaded = true;
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки топа по дням: ${error.message}`, 'error');
      }
      if (container) container.classList.remove('loading-state');
      if (loadingEl) loadingEl.style.display = 'none';
    } finally {
      this.isLoadingDayTop = false;
    }
  }

  private setupDayTopHandlers(): void {
    const monthInput = this.querySelector<HTMLInputElement>('#donations-daytop-month');
    const hideTestCheckbox = this.querySelector<HTMLInputElement>('#donations-daytop-hide-test');
    const refreshBtn = this.querySelector<HTMLButtonElement>('#donations-daytop-refresh-btn');
    const pointsInputs = this.querySelectorAll<HTMLInputElement>('.donations-daytop-points-input');

    pointsInputs.forEach((input) => {
      input.addEventListener('change', () => this.scheduleSaveDayTopPoints());
      input.addEventListener('input', () => this.scheduleSaveDayTopPoints());
    });

    monthInput?.addEventListener('click', () => {
      try {
        monthInput.showPicker?.();
      } catch {
        // showPicker может требовать user gesture — игнорируем
      }
    });

    monthInput?.addEventListener('change', () => {
      this.readDayTopMonthFromInput();
      this.dayTopLoaded = false;
      void this.loadDayTop(true);
    });

    hideTestCheckbox?.addEventListener('change', () => {
      this.dayTopHideTest = hideTestCheckbox.checked;
      this.dayTopLoaded = false;
      void this.loadDayTop(true);
    });

    refreshBtn?.addEventListener('click', () => {
      this.dayTopLoaded = false;
      void this.loadDayTop(true);
    });
  }

  private setupTopHandlers(): void {
    const hideTestCheckbox = this.querySelector<HTMLInputElement>('#donations-top-hide-test');
    hideTestCheckbox?.addEventListener('change', () => {
      this.topHideTest = hideTestCheckbox.checked;
      this.topLoaded = false;
      void this.loadTopDonors(true);
    });

    this.querySelector('#donations-top-refresh-btn')?.addEventListener('click', () => {
      this.topLoaded = false;
      void this.loadTopDonors(true);
    });

    this.querySelectorAll<HTMLButtonElement>('.donations-top-table .th-sort-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const th = btn.closest<HTMLTableCellElement>('th.sortable');
        const field = th?.dataset.sort as DonateXTopSortField | undefined;
        if (!field) return;
        if (this.topSortBy === field) {
          this.topSortDir = this.topSortDir === 'desc' ? 'asc' : 'desc';
        } else {
          this.topSortBy = field;
          this.topSortDir = 'desc';
        }
        this.topLoaded = false;
        void this.loadTopDonors(true);
      });
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'donations-table': DonationsTableElement;
  }
}

customElements.define('donations-table', DonationsTableElement);
