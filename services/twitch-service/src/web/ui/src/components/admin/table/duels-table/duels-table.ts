// @ts-ignore
import template from './duels-table.html?raw';
import './duels-table.scss';
import { showAlert } from '../../../../alerts';
import { authFetch } from '../../../../api';
import { getAdminPassword } from '../../../../admin-auth';

const WS_PATH = '/ws';
const WS_RECONNECT_MS = 3000;

function formatDuelRemaining(timeoutUntil: number): string {
  const remaining = Math.max(0, timeoutUntil - Date.now());
  if (remaining <= 0) return '0:00';
  const totalSec = Math.ceil(remaining / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m} мин ${s} сек`;
}

type DuelConfigValues = {
  timeoutMinutes: number;
  winPoints: number;
  lossPoints: number;
  missPenalty: number;
  raidBoostEnabled: boolean;
  raidBoostWinPercent: number;
  raidBoostDurationMinutes: number;
  raidBoostMinViewers: number;
};
type DailyConfigValues = { dailyGamesCount: number; dailyRewardPoints: number; streakWinsCount: number; streakRewardPoints: number };

export class DuelsTableElement extends HTMLElement {
  private initialized = false;
  private duelBannedWs: WebSocket | null = null;
  private duelBannedWsReconnect: number | null = null;
  private duelBannedTickId: number | null = null;
  private lastDuelConfig: DuelConfigValues | null = null;
  private lastDailyConfig: DailyConfigValues | null = null;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.setupHandlers();
    if (getAdminPassword()) {
      void this.bootstrap();
      this.connectDuelBannedWs();
    }
    window.addEventListener('admin-auth-success', this.handleAuthSuccess);
  }

  disconnectedCallback(): void {
    window.removeEventListener('admin-auth-success', this.handleAuthSuccess);
    if (this.duelBannedWsReconnect) {
      clearTimeout(this.duelBannedWsReconnect);
      this.duelBannedWsReconnect = null;
    }
    if (this.duelBannedWs) {
      this.duelBannedWs.close();
      this.duelBannedWs = null;
    }
    if (this.duelBannedTickId !== null) {
      clearInterval(this.duelBannedTickId);
      this.duelBannedTickId = null;
    }
  }

  private handleAuthSuccess = (): void => {
    void this.bootstrap();
    this.connectDuelBannedWs();
  };

  private getTemplate(id: string): HTMLTemplateElement | null {
    return this.querySelector<HTMLTemplateElement>(`#${id}`);
  }

  private async bootstrap(): Promise<void> {
    await this.loadDuelsStatus();
    await this.loadDuelBannedList();
    await this.loadDuelConfig();
    await this.loadDuelDailyConfig();
    await this.applyDevModeVisibility();
  }

  private connectDuelBannedWs(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}${WS_PATH}`;
    try {
      const ws = new WebSocket(url);
      this.duelBannedWs = ws;
      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data) as { type?: string };
          if (data.type === 'duel-banned-changed') void this.loadDuelBannedList();
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        this.duelBannedWs = null;
        if (!this.isConnected) return;
        this.duelBannedWsReconnect = window.setTimeout(() => {
          this.duelBannedWsReconnect = null;
          this.connectDuelBannedWs();
        }, WS_RECONNECT_MS);
      };
      ws.onerror = () => ws.close();
    } catch { /* ignore */ }
  }

  private setupHandlers(): void {
    const duelsToggle = this.querySelector('#duels-toggle');
    const duelsCooldownToggle = this.querySelector('#duels-cooldown-toggle');
    const duelsOverlaySyncToggle = this.querySelector('#duels-overlay-sync-toggle');
    const pardonAllBtn = this.querySelector('#pardon-all-btn');
    const duelConfigSaveBtn = this.querySelector('#duel-config-save-btn');
    const duelDailySaveBtn = this.querySelector('#duel-daily-save-btn');
    const duelResetRewardFlagsBtn = this.querySelector('#duel-reset-reward-flags-btn');
    const duelResetPointsBtn = this.querySelector('#duel-reset-points-btn');
    const duelsBannedContainer = this.querySelector('#duels-banned-container');

    duelsToggle?.addEventListener('click', async () => {
      const enabled = (duelsToggle as HTMLElement).getAttribute('data-enabled') === 'true';
      const endpoint = enabled ? '/api/admin/duels/disable' : '/api/admin/duels/enable';
      try {
        const res = await authFetch(endpoint, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `HTTP ${res.status}`);
        await this.loadDuelsStatus();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    duelsCooldownToggle?.addEventListener('click', async () => {
      const skipCooldown = (duelsCooldownToggle as HTMLElement).getAttribute('data-skip-cooldown') === 'true';
      try {
        const res = await authFetch('/api/admin/duels/set-cooldown-skip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skip: !skipCooldown }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `HTTP ${res.status}`);
        await this.loadDuelsStatus();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    duelsOverlaySyncToggle?.addEventListener('click', async () => {
      const enabled = (duelsOverlaySyncToggle as HTMLElement).getAttribute('data-enabled') === 'true';
      try {
        const res = await authFetch('/api/admin/duels/set-overlay-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !enabled }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `HTTP ${res.status}`);
        await this.loadDuelsStatus();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    [this.querySelector('#duel-timeout-min'), this.querySelector('#duel-win-points'), this.querySelector('#duel-loss-points'), this.querySelector('#duel-miss-penalty'), this.querySelector('#raid-boost-win-percent'), this.querySelector('#raid-boost-duration-min'), this.querySelector('#raid-boost-min-viewers')].forEach((el) => {
      el?.addEventListener('input', () => this.updateDuelConfigSaveButton());
      el?.addEventListener('change', () => this.updateDuelConfigSaveButton());
    });

    this.querySelector('#raid-boost-toggle')?.addEventListener('click', () => {
      const toggle = this.querySelector('#raid-boost-toggle') as HTMLElement;
      const enabled = toggle.getAttribute('data-enabled') === 'true';
      const next = !enabled;
      toggle.classList.toggle('on', next);
      toggle.classList.toggle('off', !next);
      toggle.setAttribute('data-enabled', String(next));
      const textEl = toggle.querySelector('.status-toggle-text');
      if (textEl) textEl.textContent = next ? 'ВКЛ' : 'ВЫКЛ';
      this.updateDuelConfigSaveButton();
    });

    [this.querySelector('#daily-games-count'), this.querySelector('#daily-reward-points'), this.querySelector('#streak-wins-count'), this.querySelector('#streak-reward-points')].forEach((el) => {
      el?.addEventListener('input', () => { this.updateDuelDailySaveButton(); this.updateDuelDailyBlockDescriptions(); });
      el?.addEventListener('change', () => { this.updateDuelDailySaveButton(); this.updateDuelDailyBlockDescriptions(); });
    });

    duelConfigSaveBtn?.addEventListener('click', async () => {
      const { timeoutMinutes, winPoints, lossPoints, missPenalty, raidBoostEnabled, raidBoostWinPercent, raidBoostDurationMinutes, raidBoostMinViewers } = this.getDuelConfigFromInputs();
      if (timeoutMinutes < 0 || winPoints < 0 || lossPoints < 0 || missPenalty < 0) { showAlert('Введите неотрицательные числа', 'error'); return; }
      if (raidBoostWinPercent < 1 || raidBoostWinPercent > 99 || raidBoostDurationMinutes < 1 || raidBoostDurationMinutes > 240 || raidBoostMinViewers < 0) {
        showAlert('Рейд-буст: шанс 1–99%, длительность 1–240 мин, мин. зрителей ≥ 0', 'error');
        return;
      }
      try {
        const res = await authFetch('/api/admin/duels/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            timeoutMinutes,
            winPoints,
            lossPoints,
            missPenalty,
            raidBoostEnabled,
            raidBoostWinPercent,
            raidBoostDurationMinutes,
            raidBoostMinViewers,
          }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `HTTP ${res.status}`);
        await this.loadDuelConfig();
      } catch (error) { if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error'); }
    });

    duelDailySaveBtn?.addEventListener('click', async () => {
      const { dailyGamesCount, dailyRewardPoints, streakWinsCount, streakRewardPoints } = this.getDuelDailyFromInputs();
      if (dailyGamesCount < 0 || dailyRewardPoints < 0 || streakWinsCount < 0 || streakRewardPoints < 0) { showAlert('Введите неотрицательные числа', 'error'); return; }
      try {
        const res = await authFetch('/api/admin/duels/daily-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dailyGamesCount, dailyRewardPoints, streakWinsCount, streakRewardPoints }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `HTTP ${res.status}`);
        await this.loadDuelDailyConfig();
      } catch (error) { if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error'); }
    });

    duelResetRewardFlagsBtn?.addEventListener('click', async () => {
      if (!confirm('Сбросить у всех игроков флаги и счётчики наград? Нужно для теста.')) return;
      try {
        const res = await authFetch('/api/admin/duels/reset-reward-flags', { method: 'POST' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `HTTP ${res.status}`);
      } catch (error) { if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error'); }
    });

    duelResetPointsBtn?.addEventListener('click', async () => {
      if (!confirm('Назначить всем игрокам по 1000 очков? Это нельзя отменить.')) return;
      try {
        const res = await authFetch('/api/admin/duels/reset-points', { method: 'POST' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `HTTP ${res.status}`);
      } catch (error) { if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error'); }
    });

    pardonAllBtn?.addEventListener('click', async () => {
      if (!confirm('Простить всех игроков (снять таймауты дуэлей)?')) return;
      try {
        const res = await authFetch('/api/admin/pardon-all', { method: 'POST' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `HTTP ${res.status}`);
        await this.loadDuelBannedList();
      } catch (error) { if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error'); }
    });

    duelsBannedContainer?.addEventListener('click', async (event: Event) => {
      const target = event.target as HTMLElement;
      const btn = target.closest<HTMLElement>('[data-action="pardon-one"]');
      if (!btn) return;
      const username = btn.closest<HTMLElement>('.duel-banned-row')?.getAttribute('data-username');
      if (!username) return;
      try {
        const res = await authFetch(`/api/admin/duels/pardon/${encodeURIComponent(username)}`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `HTTP ${res.status}`);
        await this.loadDuelBannedList();
      } catch (error) { if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error'); }
    });
  }

  private async loadDuelsStatus(): Promise<void> {
    try {
      const response = await authFetch('/api/admin/duels/status');
      const data = (await response.json()) as { enabled?: boolean; skipCooldown?: boolean; overlaySyncEnabled?: boolean };
      const toggle = this.querySelector('#duels-toggle');
      if (toggle) {
        const enabled = Boolean(data.enabled);
        toggle.classList.toggle('on', enabled);
        toggle.classList.toggle('off', !enabled);
        toggle.setAttribute('data-enabled', String(enabled));
        const textEl = toggle.querySelector('.status-toggle-text');
        if (textEl) textEl.textContent = enabled ? 'ВКЛ' : 'ВЫКЛ';
      }
      const cooldownToggle = this.querySelector('#duels-cooldown-toggle');
      if (cooldownToggle) {
        const skipCooldown = Boolean(data.skipCooldown);
        const cooldownOn = !skipCooldown;
        cooldownToggle.classList.toggle('on', cooldownOn);
        cooldownToggle.classList.toggle('off', !cooldownOn);
        cooldownToggle.setAttribute('data-skip-cooldown', String(skipCooldown));
        const cooldownText = cooldownToggle.querySelector('.status-toggle-text');
        if (cooldownText) cooldownText.textContent = cooldownOn ? 'ВКЛ' : 'ВЫКЛ';
      }
      const overlaySyncToggle = this.querySelector('#duels-overlay-sync-toggle');
      if (overlaySyncToggle) {
        const overlaySyncEnabled = Boolean(data.overlaySyncEnabled);
        overlaySyncToggle.classList.toggle('on', overlaySyncEnabled);
        overlaySyncToggle.classList.toggle('off', !overlaySyncEnabled);
        overlaySyncToggle.setAttribute('data-enabled', String(overlaySyncEnabled));
        const overlayText = overlaySyncToggle.querySelector('.status-toggle-text');
        if (overlayText) overlayText.textContent = overlaySyncEnabled ? 'ВКЛ' : 'ВЫКЛ';
      }
    } catch (error) { console.error('Ошибка загрузки статуса дуэлей:', error); }
  }

  private async loadDuelBannedList(): Promise<void> {
    try {
      const res = await authFetch('/api/admin/duels/banned');
      const data = (await res.json()) as { list?: { username: string; timeoutUntil: number }[] };
      this.renderDuelBannedTable(data.list ?? []);
    } catch (error) {
      console.error('Ошибка загрузки списка забаненных:', error);
      this.renderDuelBannedTable([]);
    }
  }

  private renderDuelBannedTable(list: { username: string; timeoutUntil: number }[]): void {
    const tbody = this.querySelector('#duels-banned-tbody');
    const table = this.querySelector<HTMLTableElement>('#duels-banned-table');
    const emptyEl = this.querySelector<HTMLElement>('#duels-banned-empty');
    const rowTpl = this.getTemplate('template-duel-banned-row');
    if (!tbody || !table || !emptyEl || !rowTpl) return;
    if (this.duelBannedTickId !== null) { clearInterval(this.duelBannedTickId); this.duelBannedTickId = null; }
    tbody.innerHTML = '';
    list.forEach((item, index) => {
      const tr = (rowTpl.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLTableRowElement;
      tr.setAttribute('data-username', item.username);
      tr.setAttribute('data-timeout-until', String(item.timeoutUntil));
      const numCell = tr.querySelector('.col-num');
      const usernameCell = tr.querySelector('.col-username');
      const untilCell = tr.querySelector('.col-until');
      if (numCell) numCell.textContent = String(index + 1);
      if (usernameCell) usernameCell.textContent = item.username;
      if (untilCell) untilCell.textContent = formatDuelRemaining(item.timeoutUntil);
      tbody.appendChild(tr);
    });
    const hasRows = list.length > 0;
    table.style.display = hasRows ? 'table' : 'none';
    emptyEl.style.display = hasRows ? 'none' : 'block';
    if (hasRows) this.duelBannedTickId = window.setInterval(() => this.updateDuelBannedCountdown(), 1000);
  }

  private updateDuelBannedCountdown(): void {
    const tbody = this.querySelector('#duels-banned-tbody');
    const table = this.querySelector<HTMLTableElement>('#duels-banned-table');
    const emptyEl = this.querySelector<HTMLElement>('#duels-banned-empty');
    if (!tbody || !table || !emptyEl) return;
    const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('.duel-banned-row'));
    for (const tr of rows) {
      const raw = tr.getAttribute('data-timeout-until');
      const timeoutUntil = raw ? Number(raw) : 0;
      const untilCell = tr.querySelector('.col-until');
      if (untilCell) untilCell.textContent = formatDuelRemaining(timeoutUntil);
      if (timeoutUntil - Date.now() <= 0) tr.remove();
    }
    const left = tbody.querySelectorAll('.duel-banned-row');
    left.forEach((tr, index) => { const numCell = tr.querySelector('.col-num'); if (numCell) numCell.textContent = String(index + 1); });
    const hasRows = left.length > 0;
    if (!hasRows) {
      table.style.display = 'none';
      emptyEl.style.display = 'block';
      if (this.duelBannedTickId !== null) { clearInterval(this.duelBannedTickId); this.duelBannedTickId = null; }
    }
  }

  private async loadDuelConfig(): Promise<void> {
    try {
      const res = await authFetch('/api/admin/duels/config');
      const data = (await res.json()) as {
        timeoutMinutes?: number;
        winPoints?: number;
        lossPoints?: number;
        missPenalty?: number;
        raidBoostEnabled?: boolean;
        raidBoostWinPercent?: number;
        raidBoostDurationMinutes?: number;
        raidBoostMinViewers?: number;
      };
      const timeoutMinutes = data.timeoutMinutes ?? 5;
      const winPoints = data.winPoints ?? 25;
      const lossPoints = data.lossPoints ?? 25;
      const missPenalty = data.missPenalty ?? 5;
      const raidBoostEnabled = Boolean(data.raidBoostEnabled);
      const raidBoostWinPercent = data.raidBoostWinPercent ?? 70;
      const raidBoostDurationMinutes = data.raidBoostDurationMinutes ?? 10;
      const raidBoostMinViewers = data.raidBoostMinViewers ?? 5;
      this.lastDuelConfig = {
        timeoutMinutes,
        winPoints,
        lossPoints,
        missPenalty,
        raidBoostEnabled,
        raidBoostWinPercent,
        raidBoostDurationMinutes,
        raidBoostMinViewers,
      };
      const timeoutInput = this.querySelector<HTMLInputElement>('#duel-timeout-min');
      const winInput = this.querySelector<HTMLInputElement>('#duel-win-points');
      const lossInput = this.querySelector<HTMLInputElement>('#duel-loss-points');
      const missPenaltyInput = this.querySelector<HTMLInputElement>('#duel-miss-penalty');
      const raidWinInput = this.querySelector<HTMLInputElement>('#raid-boost-win-percent');
      const raidDurInput = this.querySelector<HTMLInputElement>('#raid-boost-duration-min');
      const raidMinVInput = this.querySelector<HTMLInputElement>('#raid-boost-min-viewers');
      const raidToggle = this.querySelector<HTMLElement>('#raid-boost-toggle');
      if (timeoutInput) timeoutInput.value = String(timeoutMinutes);
      if (winInput) winInput.value = String(winPoints);
      if (lossInput) lossInput.value = String(lossPoints);
      if (missPenaltyInput) missPenaltyInput.value = String(missPenalty);
      if (raidWinInput) raidWinInput.value = String(raidBoostWinPercent);
      if (raidDurInput) raidDurInput.value = String(raidBoostDurationMinutes);
      if (raidMinVInput) raidMinVInput.value = String(raidBoostMinViewers);
      if (raidToggle) {
        raidToggle.classList.toggle('on', raidBoostEnabled);
        raidToggle.classList.toggle('off', !raidBoostEnabled);
        raidToggle.setAttribute('data-enabled', String(raidBoostEnabled));
        const t = raidToggle.querySelector('.status-toggle-text');
        if (t) t.textContent = raidBoostEnabled ? 'ВКЛ' : 'ВЫКЛ';
      }
      this.updateDuelConfigSaveButton();
    } catch (error) { console.error('Ошибка загрузки конфига дуэлей:', error); }
  }

  private getDuelConfigFromInputs(): DuelConfigValues {
    const timeoutInput = this.querySelector<HTMLInputElement>('#duel-timeout-min');
    const winInput = this.querySelector<HTMLInputElement>('#duel-win-points');
    const lossInput = this.querySelector<HTMLInputElement>('#duel-loss-points');
    const missPenaltyInput = this.querySelector<HTMLInputElement>('#duel-miss-penalty');
    const raidWinInput = this.querySelector<HTMLInputElement>('#raid-boost-win-percent');
    const raidDurInput = this.querySelector<HTMLInputElement>('#raid-boost-duration-min');
    const raidMinVInput = this.querySelector<HTMLInputElement>('#raid-boost-min-viewers');
    const raidToggle = this.querySelector<HTMLElement>('#raid-boost-toggle');
    return {
      timeoutMinutes: timeoutInput ? parseInt(timeoutInput.value, 10) || 0 : 0,
      winPoints: winInput ? parseInt(winInput.value, 10) || 0 : 0,
      lossPoints: lossInput ? parseInt(lossInput.value, 10) || 0 : 0,
      missPenalty: missPenaltyInput ? parseInt(missPenaltyInput.value, 10) || 0 : 0,
      raidBoostEnabled: raidToggle ? raidToggle.getAttribute('data-enabled') === 'true' : false,
      raidBoostWinPercent: raidWinInput ? parseInt(raidWinInput.value, 10) || 0 : 0,
      raidBoostDurationMinutes: raidDurInput ? parseInt(raidDurInput.value, 10) || 0 : 0,
      raidBoostMinViewers: raidMinVInput ? parseInt(raidMinVInput.value, 10) || 0 : 0,
    };
  }

  private updateDuelConfigSaveButton(): void {
    const btn = this.querySelector<HTMLButtonElement>('#duel-config-save-btn');
    if (!btn) return;
    const current = this.getDuelConfigFromInputs();
    const same = this.lastDuelConfig !== null
      && this.lastDuelConfig.timeoutMinutes === current.timeoutMinutes
      && this.lastDuelConfig.winPoints === current.winPoints
      && this.lastDuelConfig.lossPoints === current.lossPoints
      && this.lastDuelConfig.missPenalty === current.missPenalty
      && this.lastDuelConfig.raidBoostEnabled === current.raidBoostEnabled
      && this.lastDuelConfig.raidBoostWinPercent === current.raidBoostWinPercent
      && this.lastDuelConfig.raidBoostDurationMinutes === current.raidBoostDurationMinutes
      && this.lastDuelConfig.raidBoostMinViewers === current.raidBoostMinViewers;
    btn.disabled = same;
  }

  private async applyDevModeVisibility(): Promise<void> {
    try {
      const res = await authFetch('/api/admin/dev-mode');
      const data = (await res.json()) as { devMode?: boolean };
      const devActions = this.querySelector<HTMLElement>('#duels-dev-actions');
      if (devActions) devActions.style.display = data.devMode ? 'flex' : 'none';
    } catch { /* ignore */ }
  }

  private async loadDuelDailyConfig(): Promise<void> {
    try {
      const res = await authFetch('/api/admin/duels/daily-config');
      const data = (await res.json()) as { dailyGamesCount?: number; dailyRewardPoints?: number; streakWinsCount?: number; streakRewardPoints?: number };
      const dailyGamesCount = data.dailyGamesCount ?? 5;
      const dailyRewardPoints = data.dailyRewardPoints ?? 50;
      const streakWinsCount = data.streakWinsCount ?? 3;
      const streakRewardPoints = data.streakRewardPoints ?? 100;
      this.lastDailyConfig = { dailyGamesCount, dailyRewardPoints, streakWinsCount, streakRewardPoints };
      const dailyInput = this.querySelector<HTMLInputElement>('#daily-games-count');
      const rewardInput = this.querySelector<HTMLInputElement>('#daily-reward-points');
      const streakWinsInput = this.querySelector<HTMLInputElement>('#streak-wins-count');
      const streakRewardInput = this.querySelector<HTMLInputElement>('#streak-reward-points');
      if (dailyInput) dailyInput.value = String(dailyGamesCount);
      if (rewardInput) rewardInput.value = String(dailyRewardPoints);
      if (streakWinsInput) streakWinsInput.value = String(streakWinsCount);
      if (streakRewardInput) streakRewardInput.value = String(streakRewardPoints);
      this.updateDuelDailySaveButton();
      this.updateDuelDailyBlockDescriptions();
    } catch (error) { console.error('Ошибка загрузки конфига дейликов:', error); }
  }

  private getDuelDailyFromInputs(): DailyConfigValues {
    const dailyInput = this.querySelector<HTMLInputElement>('#daily-games-count');
    const rewardInput = this.querySelector<HTMLInputElement>('#daily-reward-points');
    const streakWinsInput = this.querySelector<HTMLInputElement>('#streak-wins-count');
    const streakRewardInput = this.querySelector<HTMLInputElement>('#streak-reward-points');
    return {
      dailyGamesCount: dailyInput ? parseInt(dailyInput.value, 10) || 0 : 0,
      dailyRewardPoints: rewardInput ? parseInt(rewardInput.value, 10) || 0 : 0,
      streakWinsCount: streakWinsInput ? parseInt(streakWinsInput.value, 10) || 0 : 0,
      streakRewardPoints: streakRewardInput ? parseInt(streakRewardInput.value, 10) || 0 : 0,
    };
  }

  private updateDuelDailySaveButton(): void {
    const btn = this.querySelector<HTMLButtonElement>('#duel-daily-save-btn');
    if (!btn) return;
    const current = this.getDuelDailyFromInputs();
    const same = this.lastDailyConfig !== null && this.lastDailyConfig.dailyGamesCount === current.dailyGamesCount && this.lastDailyConfig.dailyRewardPoints === current.dailyRewardPoints && this.lastDailyConfig.streakWinsCount === current.streakWinsCount && this.lastDailyConfig.streakRewardPoints === current.streakRewardPoints;
    btn.disabled = same;
  }

  private updateDuelDailyBlockDescriptions(): void {
    const { dailyGamesCount, streakWinsCount } = this.getDuelDailyFromInputs();
    const rewardDesc = this.querySelector<HTMLParagraphElement>('.duels-daily-block--reward .duels-daily-block-desc');
    const streakDesc = this.querySelector<HTMLParagraphElement>('.duels-daily-block--streak .duels-daily-block-desc');
    if (rewardDesc) rewardDesc.textContent = `За ${dailyGamesCount} побед за день — бонус очками`;
    if (streakDesc) streakDesc.textContent = `${streakWinsCount} побед подряд — бонус очками`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'duels-table': DuelsTableElement;
  }
}

customElements.define('duels-table', DuelsTableElement);
