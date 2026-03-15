// @ts-ignore
import template from './admin-panel.html?raw';
import './admin-panel.scss';
import { showAlert } from '../../alerts';
import {
  createCommand,
  deleteCommand,
  fetchCommands,
  fetchLinksConfig,
  updateLinksConfig,
  toggleCommand,
  toggleCommandRotation,
  updateCommand,
  fetchCounters,
  createCounter,
  updateCounter,
  deleteCounter,
  toggleCounter,
  fetchPartyItems,
  createPartyItem,
  updatePartyItem,
  deletePartyItem,
  fetchPartyConfig,
  updatePartyConfig,
  setPartySkipCooldown,
} from '../../api';
import type { CommandsData, CustomCommand, CountersData, PartyItemsData } from '../../types';
import type { CommandDialogElement, CommandDialogSaveDetail } from '../command-dialog/command-dialog';
import type { LinkDialogSaveDetail } from '../../interfaces/link-dialog';
import type { LinkDialogElement } from '../link-dialog/link-dialog';
import type { CounterDialogElement, CounterDialogSaveDetail, CounterDialogDeleteDetail } from '../counter-dialog/counter-dialog';
import type { PartyDialogElement, PartyDialogSaveDetail } from '../party-dialog/party-dialog';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

type DuelConfigValues = { timeoutMinutes: number; winPoints: number; lossPoints: number; missPenalty: number };
type DailyConfigValues = { dailyGamesCount: number; dailyRewardPoints: number; streakWinsCount: number; streakRewardPoints: number };

export class AdminPanelElement extends HTMLElement {
  private initialized = false;
  private duelBannedWs: WebSocket | null = null;
  private duelBannedWsReconnect: number | null = null;
  private duelBannedTickId: number | null = null;
  private lastDuelConfig: DuelConfigValues | null = null;
  private lastDailyConfig: DailyConfigValues | null = null;
  private lastLinksRotationMinutes: number | null = null;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.bootstrap().catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  }

  disconnectedCallback(): void {
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

  private connectDuelBannedWs(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}${WS_PATH}`;
    try {
      const ws = new WebSocket(url);
      this.duelBannedWs = ws;
      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data) as { type?: string };
          if (data.type === 'duel-banned-changed') {
            void this.loadDuelBannedList();
          }
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        this.duelBannedWs = null;
        if (!this.isConnected) return;
        this.duelBannedWsReconnect = window.setTimeout(() => {
          this.duelBannedWsReconnect = null;
          this.connectDuelBannedWs();
        }, WS_RECONNECT_MS);
      };
      ws.onerror = () => {
        ws.close();
      };
    } catch {
      // ignore
    }
  }

  private setupTabs(): void {
    const root = this;
    const tabButtons = root.querySelectorAll<HTMLButtonElement>('.tab-btn');
    const tabContents = root.querySelectorAll<HTMLElement>('.tab-content');

    const tabsContainer = root.querySelector<HTMLElement>('.tabs');

    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        if (!targetTab) return;
        tabButtons.forEach((b) => b.classList.remove('active'));
        tabContents.forEach((c) => {
          c.classList.remove('active');
          c.style.display = 'none';
        });
        btn.classList.add('active');
        const targetContent = root.querySelector(`#tab-${targetTab}`);
        if (targetContent) {
          targetContent.classList.add('active');
          (targetContent as HTMLElement).style.display = 'block';
        }
        // прокрутить к активному табу на мобилке
        if (tabsContainer) {
          btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      });
    });
  }

  private getTemplate(id: string): HTMLTemplateElement | null {
    return this.querySelector<HTMLTemplateElement>(`#${id}`);
  }

  private renderCommands(data: CommandsData): void {
    const container = this.querySelector<HTMLElement>('#commands-container');
    const emptyState = this.querySelector<HTMLElement>('#empty-state');
    const table = this.querySelector<HTMLTableElement>('#commands-table');
    const tbody = this.querySelector<HTMLElement>('#commands-tbody');
    const rowTpl = this.getTemplate('template-command-row');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');

    if (!container || !emptyState || !table || !tbody || !rowTpl) return;

    container.classList.remove('loading-state');
    if (loadingEl) loadingEl.style.display = 'none';
    tbody.innerHTML = '';

    if (data.commands.length === 0) {
      table.style.display = 'none';
      if (loadingEl) loadingEl.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';
    table.style.display = 'table';

    data.commands.forEach((cmd, index) => {
      const tr = (rowTpl.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLTableRowElement;
      tr.dataset.id = encodeURIComponent(cmd.id);
      tr.dataset.messageType = cmd.messageType;
      tr.dataset.color = cmd.color ?? '';
      tr.classList.toggle('disabled', !cmd.enabled);

      const numCell = tr.querySelector('.col-num');
      const triggerCell = tr.querySelector('.col-trigger');
      const responseCell = tr.querySelector('.col-response');
      const statusBtn = tr.querySelector<HTMLButtonElement>('.col-status [data-action="toggle"]');
      const rotationBtn = tr.querySelector<HTMLButtonElement>('.col-rotation [data-action="toggle-rotation"]');
      const sendBtn = tr.querySelector<HTMLButtonElement>('.col-actions [data-action="send"]');

      if (numCell) numCell.textContent = String(index + 1);
      const triggerText = triggerCell?.querySelector('.trigger-text');
      if (triggerText) {
        triggerText.textContent = cmd.trigger;
        triggerCell!.setAttribute('title', cmd.trigger);
      }
      if (responseCell) {
        responseCell.textContent = cmd.response;
        responseCell.setAttribute('title', cmd.response);
      }
      if (statusBtn) {
        statusBtn.textContent = cmd.enabled ? 'ВКЛ' : 'ВЫКЛ';
        statusBtn.className = `status-badge ${cmd.enabled ? 'on' : 'off'}`;
        statusBtn.title = cmd.enabled ? 'Выключить' : 'Включить';
      }
      if (rotationBtn) {
        rotationBtn.textContent = cmd.inRotation ? 'ДА' : 'НЕТ';
        rotationBtn.className = `status-badge rotation-badge ${cmd.inRotation ? 'on' : 'off'}`;
        rotationBtn.title = cmd.inRotation ? 'Убрать из ротации' : 'Добавить в ротацию';
      }
      if (sendBtn) sendBtn.disabled = !cmd.enabled;
      tbody.appendChild(tr);
    });
  }

  private async loadCommands(): Promise<void> {
    try {
      const data = await fetchCommands();
      this.renderCommands(data);
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки команд: ${error.message}`, 'error');
      }
    }
  }

  private renderCounters(data: CountersData): void {
    const container = this.querySelector<HTMLElement>('#counters-container');
    const table = this.querySelector<HTMLTableElement>('#counters-table');
    const tbody = this.querySelector<HTMLTableSectionElement>('#counters-tbody');
    const emptyState = this.querySelector<HTMLElement>('#counters-empty-state');
    if (!container || !table || !tbody || !emptyState) return;

    container.classList.remove('loading-state');
    const loadingEl = container.querySelector('.loading');
    if (loadingEl) (loadingEl as HTMLElement).style.display = 'none';
    tbody.innerHTML = '';

    const rowTpl = this.getTemplate('template-counter-row');
    if (!rowTpl || !data.counters.length) {
      table.style.display = 'none';
      emptyState.style.display = data.counters.length === 0 ? 'block' : 'none';
      return;
    }

    table.style.display = 'table';
    emptyState.style.display = 'none';

    data.counters.forEach((counter, index) => {
      const tr = rowTpl.content.cloneNode(true) as DocumentFragment;
      const row = tr.firstElementChild as HTMLTableRowElement;
      if (!row) return;
      row.dataset.id = encodeURIComponent(counter.id);
      row.classList.toggle('disabled', !counter.enabled);

      const numCell = row.querySelector('.col-num');
      const triggerCell = row.querySelector('.col-trigger .trigger-text');
      const valueCell = row.querySelector('.col-value');
      const descCell = row.querySelector('.col-description');
      const statusBtn = row.querySelector<HTMLButtonElement>('.col-status .status-badge');

      if (numCell) numCell.textContent = String(index + 1);
      if (triggerCell) triggerCell.textContent = counter.trigger;
      if (valueCell) valueCell.textContent = String(counter.value);
      if (descCell) {
        const tpl = counter.responseTemplate || '';
        descCell.textContent = tpl || '—';
        if (tpl) descCell.setAttribute('title', tpl);
      }
      if (statusBtn) {
        statusBtn.textContent = counter.enabled ? 'ВКЛ' : 'ВЫКЛ';
        statusBtn.classList.toggle('on', counter.enabled);
        statusBtn.classList.toggle('off', !counter.enabled);
      }
      tbody.appendChild(tr);
    });
  }

  private async loadCounters(): Promise<void> {
    try {
      const data = await fetchCounters();
      this.renderCounters(data);
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки счётчиков: ${error.message}`, 'error');
      }
    }
  }

  private renderPartyItems(data: PartyItemsData): void {
    const container = this.querySelector<HTMLElement>('#party-items-container');
    if (!container) return;

    container.innerHTML = '';
    container.classList.remove('loading-state');

    const table = document.createElement('table');
    table.className = 'party-items-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th class="col-num">№</th>
          <th class="col-name">Название</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody')!;

    const sorted = [...data.items].sort((a, b) => a.text.localeCompare(b.text, 'ru'));
    sorted.forEach((item, index) => {
      const tr = document.createElement('tr');
      tr.className = 'party-table-row';
      tr.dataset.id = String(item.id);
      tr.innerHTML = `
        <td class="col-num">${index + 1}</td>
        <td class="col-name" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</td>
      `;
      tbody.appendChild(tr);
    });

    container.appendChild(table);
  }

  private async loadPartyItems(): Promise<void> {
    try {
      const data = await fetchPartyItems();
      this.renderPartyItems(data);
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки партии: ${error.message}`, 'error');
      }
    }
  }

  private async loadPartyConfig(): Promise<void> {
    try {
      const config = await fetchPartyConfig();
      const ec = this.querySelector('#party-elements-count') as HTMLInputElement;
      const qm = this.querySelector('#party-quantity-max') as HTMLInputElement;
      const toggle = this.querySelector('#party-skip-cooldown-toggle');
      if (ec) ec.value = String(config.elementsCount);
      if (qm) qm.value = String(config.quantityMax);
      if (toggle) {
        const on = config.skipCooldown;
        toggle.classList.toggle('on', on);
        toggle.classList.toggle('off', !on);
        toggle.setAttribute('data-enabled', String(on));
        const textEl = toggle.querySelector('.status-toggle-text');
        if (textEl) textEl.textContent = on ? 'Ограничение ВЫКЛ' : 'Ограничение ВКЛ';
      }
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки настроек партии: ${error.message}`, 'error');
      }
    }
  }

  private async loadDuelsStatus(): Promise<boolean> {
    try {
      const response = await fetch('/api/admin/duels/status');
      const data = (await response.json()) as { enabled?: boolean; skipCooldown?: boolean };
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
        // ВКЛ = КД активен (skipCooldown false), ВЫКЛ = без КД для тестов (skipCooldown true)
        const cooldownOn = !skipCooldown;
        cooldownToggle.classList.toggle('on', cooldownOn);
        cooldownToggle.classList.toggle('off', !cooldownOn);
        cooldownToggle.setAttribute('data-skip-cooldown', String(skipCooldown));
        const cooldownText = cooldownToggle.querySelector('.status-toggle-text');
        if (cooldownText) cooldownText.textContent = cooldownOn ? 'ВКЛ' : 'ВЫКЛ';
      }
      return Boolean(data?.enabled);
    } catch (error) {
      console.error('Ошибка загрузки статуса дуэлей:', error);
      return false;
    }
  }

  private async loadDuelBannedList(): Promise<void> {
    try {
      const res = await fetch('/api/admin/duels/banned');
      const data = (await res.json()) as { list?: { username: string; timeoutUntil: number }[] };
      this.renderDuelBannedTable(data.list ?? []);
    } catch (error) {
      console.error('Ошибка загрузки списка забаненных:', error);
      this.renderDuelBannedTable([]);
    }
  }

  private async loadDuelConfig(): Promise<void> {
    try {
      const res = await fetch('/api/admin/duels/config');
      const data = (await res.json()) as { timeoutMinutes?: number; winPoints?: number; lossPoints?: number; missPenalty?: number };
      const timeoutMinutes = data.timeoutMinutes ?? 5;
      const winPoints = data.winPoints ?? 25;
      const lossPoints = data.lossPoints ?? 25;
      const missPenalty = data.missPenalty ?? 5;
      const timeoutInput = this.querySelector<HTMLInputElement>('#duel-timeout-min');
      const winInput = this.querySelector<HTMLInputElement>('#duel-win-points');
      const lossInput = this.querySelector<HTMLInputElement>('#duel-loss-points');
      const missPenaltyInput = this.querySelector<HTMLInputElement>('#duel-miss-penalty');
      if (timeoutInput) timeoutInput.value = String(timeoutMinutes);
      if (winInput) winInput.value = String(winPoints);
      if (lossInput) lossInput.value = String(lossPoints);
      if (missPenaltyInput) missPenaltyInput.value = String(missPenalty);
      this.lastDuelConfig = { timeoutMinutes, winPoints, lossPoints, missPenalty };
      this.updateDuelConfigSaveButton();
    } catch (error) {
      console.error('Ошибка загрузки конфига дуэлей:', error);
    }
  }

  private getDuelConfigFromInputs(): DuelConfigValues {
    const timeoutInput = this.querySelector<HTMLInputElement>('#duel-timeout-min');
    const winInput = this.querySelector<HTMLInputElement>('#duel-win-points');
    const lossInput = this.querySelector<HTMLInputElement>('#duel-loss-points');
    const missPenaltyInput = this.querySelector<HTMLInputElement>('#duel-miss-penalty');
    return {
      timeoutMinutes: timeoutInput ? parseInt(timeoutInput.value, 10) || 0 : 0,
      winPoints: winInput ? parseInt(winInput.value, 10) || 0 : 0,
      lossPoints: lossInput ? parseInt(lossInput.value, 10) || 0 : 0,
      missPenalty: missPenaltyInput ? parseInt(missPenaltyInput.value, 10) || 0 : 0,
    };
  }

  private updateDuelConfigSaveButton(): void {
    const btn = this.querySelector<HTMLButtonElement>('#duel-config-save-btn');
    if (!btn) return;
    const current = this.getDuelConfigFromInputs();
    const same =
      this.lastDuelConfig !== null &&
      this.lastDuelConfig.timeoutMinutes === current.timeoutMinutes &&
      this.lastDuelConfig.winPoints === current.winPoints &&
      this.lastDuelConfig.lossPoints === current.lossPoints &&
      this.lastDuelConfig.missPenalty === current.missPenalty;
    btn.disabled = same;
  }

  private async applyDevModeVisibility(): Promise<void> {
    try {
      const res = await fetch('/api/admin/dev-mode');
      const data = (await res.json()) as { devMode?: boolean };
      const devActions = this.querySelector<HTMLElement>('#duels-dev-actions');
      if (devActions) {
        devActions.style.display = data.devMode ? 'flex' : 'none';
      }
    } catch {
      // в случае ошибки кнопки сброса не показываем
    }
  }

  private async loadDuelDailyConfig(): Promise<void> {
    try {
      const res = await fetch('/api/admin/duels/daily-config');
      const data = (await res.json()) as {
        dailyGamesCount?: number;
        dailyRewardPoints?: number;
        streakWinsCount?: number;
        streakRewardPoints?: number;
      };
      const dailyGamesCount = data.dailyGamesCount ?? 5;
      const dailyRewardPoints = data.dailyRewardPoints ?? 50;
      const streakWinsCount = data.streakWinsCount ?? 3;
      const streakRewardPoints = data.streakRewardPoints ?? 100;
      const dailyInput = this.querySelector<HTMLInputElement>('#daily-games-count');
      const rewardInput = this.querySelector<HTMLInputElement>('#daily-reward-points');
      const streakWinsInput = this.querySelector<HTMLInputElement>('#streak-wins-count');
      const streakRewardInput = this.querySelector<HTMLInputElement>('#streak-reward-points');
      if (dailyInput) dailyInput.value = String(dailyGamesCount);
      if (rewardInput) rewardInput.value = String(dailyRewardPoints);
      if (streakWinsInput) streakWinsInput.value = String(streakWinsCount);
      if (streakRewardInput) streakRewardInput.value = String(streakRewardPoints);
      this.lastDailyConfig = { dailyGamesCount, dailyRewardPoints, streakWinsCount, streakRewardPoints };
      this.updateDuelDailySaveButton();
      this.updateDuelDailyBlockDescriptions();
    } catch (error) {
      console.error('Ошибка загрузки конфига дейликов:', error);
    }
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
    const same =
      this.lastDailyConfig !== null &&
      this.lastDailyConfig.dailyGamesCount === current.dailyGamesCount &&
      this.lastDailyConfig.dailyRewardPoints === current.dailyRewardPoints &&
      this.lastDailyConfig.streakWinsCount === current.streakWinsCount &&
      this.lastDailyConfig.streakRewardPoints === current.streakRewardPoints;
    btn.disabled = same;
  }

  private updateDuelDailyBlockDescriptions(): void {
    const { dailyGamesCount, streakWinsCount } = this.getDuelDailyFromInputs();
    const rewardDesc = this.querySelector<HTMLParagraphElement>('.duels-daily-block--reward .duels-daily-block-desc');
    const streakDesc = this.querySelector<HTMLParagraphElement>('.duels-daily-block--streak .duels-daily-block-desc');
    if (rewardDesc) rewardDesc.textContent = `За ${dailyGamesCount} побед за день — бонус очками`;
    if (streakDesc) streakDesc.textContent = `${streakWinsCount} побед подряд — бонус очками`;
  }

  private renderDuelBannedTable(list: { username: string; timeoutUntil: number }[]): void {
    const tbody = this.querySelector('#duels-banned-tbody');
    const table = this.querySelector<HTMLTableElement>('#duels-banned-table');
    const emptyEl = this.querySelector<HTMLElement>('#duels-banned-empty');
    const rowTpl = this.getTemplate('template-duel-banned-row');
    if (!tbody || !table || !emptyEl || !rowTpl) return;

    if (this.duelBannedTickId !== null) {
      clearInterval(this.duelBannedTickId);
      this.duelBannedTickId = null;
    }

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

    if (hasRows) {
      this.duelBannedTickId = window.setInterval(() => this.updateDuelBannedCountdown(), 1000);
    }
  }

  private updateDuelBannedCountdown(): void {
    const tbody = this.querySelector('#duels-banned-tbody');
    const table = this.querySelector<HTMLTableElement>('#duels-banned-table');
    const emptyEl = this.querySelector<HTMLElement>('#duels-banned-empty');
    if (!tbody || !table || !emptyEl) return;

    const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('.duel-banned-row'));
    const now = Date.now();
    let removed = 0;
    for (const tr of rows) {
      const raw = tr.getAttribute('data-timeout-until');
      const timeoutUntil = raw ? Number(raw) : 0;
      const remaining = timeoutUntil - now;
      const untilCell = tr.querySelector('.col-until');
      if (untilCell) untilCell.textContent = formatDuelRemaining(timeoutUntil);
      if (remaining <= 0) {
        tr.remove();
        removed++;
      }
    }

    if (removed > 0) {
      // Перенумеровать оставшиеся строки
      const left = tbody.querySelectorAll('.duel-banned-row');
      left.forEach((tr, index) => {
        const numCell = tr.querySelector('.col-num');
        if (numCell) numCell.textContent = String(index + 1);
      });
    }

    const hasRows = tbody.querySelectorAll('.duel-banned-row').length > 0;
    if (!hasRows) {
      table.style.display = 'none';
      emptyEl.style.display = 'block';
      if (this.duelBannedTickId !== null) {
        clearInterval(this.duelBannedTickId);
        this.duelBannedTickId = null;
      }
    }
  }

  private async initLinks(linkDialog: LinkDialogElement): Promise<void> {
    try {
      const config = await fetchLinksConfig();
      this.lastLinksRotationMinutes = config.rotationIntervalMinutes ?? 13;
      const linksIntervalInput = this.querySelector<HTMLInputElement>('#links-rotation-interval-min');
      if (linksIntervalInput) {
        linksIntervalInput.value = String(this.lastLinksRotationMinutes);
      }
      linkDialog.open({
        allLinksText: config.allLinksText ?? '',
      });
      linkDialog.close();
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки ссылок: ${error.message}`, 'error');
      }
    }
  }

  private async bootstrap(): Promise<void> {
    const allLinksBtn = this.querySelector('#all-links-btn');
    const commandsContainer = this.querySelector('#commands-container');
    const commandDialog = document.querySelector<CommandDialogElement>('command-dialog');
    const linkDialog = document.querySelector<LinkDialogElement>('link-dialog');
    const counterDialog = document.querySelector<CounterDialogElement>('counter-dialog');
    const partyDialog = document.querySelector<PartyDialogElement>('party-dialog');

    if (!allLinksBtn || !commandsContainer || !commandDialog || !linkDialog || !counterDialog || !partyDialog) {
      return;
    }

    this.setupTabs();
    await this.initLinks(linkDialog);
    await this.loadCommands();
    await this.loadCounters();
    await this.loadDuelsStatus();
    await this.loadDuelBannedList();
    await this.loadDuelConfig();
    await this.loadDuelDailyConfig();
    await this.applyDevModeVisibility();
    await this.loadPartyItems();
    await this.loadPartyConfig();
    this.connectDuelBannedWs();

    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('#add-command-btn')) {
        commandDialog.openForCreate();
      } else if (target.closest('#add-counter-btn')) {
        counterDialog.openForCreate();
      } else if (target.closest('#add-party-item-btn')) {
        partyDialog.openForCreate();
      }
    });

    const partySkipCooldownToggle = this.querySelector('#party-skip-cooldown-toggle');
    partySkipCooldownToggle?.addEventListener('click', async () => {
      const on = (partySkipCooldownToggle as HTMLElement).getAttribute('data-enabled') === 'true';
      const newVal = !on;
      try {
        await setPartySkipCooldown(newVal);
        (partySkipCooldownToggle as HTMLElement).setAttribute('data-enabled', String(newVal));
        partySkipCooldownToggle.classList.toggle('on', newVal);
        partySkipCooldownToggle.classList.toggle('off', !newVal);
        const textEl = partySkipCooldownToggle.querySelector('.status-toggle-text');
        if (textEl) textEl.textContent = newVal ? 'Ограничение ВЫКЛ' : 'Ограничение ВКЛ';
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    const partyConfigSaveBtn = this.querySelector('#party-config-save-btn');
    partyConfigSaveBtn?.addEventListener('click', async () => {
      const ec = this.querySelector('#party-elements-count') as HTMLInputElement;
      const qm = this.querySelector('#party-quantity-max') as HTMLInputElement;
      const elementsCount = Math.min(10, Math.max(1, parseInt(ec?.value || '2', 10) || 2));
      const quantityMax = Math.min(99, Math.max(1, parseInt(qm?.value || '4', 10) || 4));
      try {
        const toggle = this.querySelector('#party-skip-cooldown-toggle');
        const skipCooldown = (toggle as HTMLElement)?.getAttribute('data-enabled') === 'true';
        await updatePartyConfig({ elementsCount, quantityMax, skipCooldown: skipCooldown ?? false });
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    partyDialog.addEventListener('save', async (event: Event) => {
      const customEvent = event as CustomEvent<PartyDialogSaveDetail>;
      const { editId, text } = customEvent.detail;
      try {
        if (editId != null) {
          await updatePartyItem(editId, text);
        } else {
          await createPartyItem(text);
        }
        partyDialog.close();
        await this.loadPartyItems();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    partyDialog.addEventListener('delete', async (event: Event) => {
      const customEvent = event as CustomEvent<{ editId: number }>;
      const editId = customEvent.detail?.editId;
      if (editId == null) return;
      try {
        await deletePartyItem(editId);
        partyDialog.close();
        await this.loadPartyItems();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    const partyItemsContainer = this.querySelector('#party-items-container');
    partyItemsContainer?.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement;
      const row = target.closest<HTMLElement>('.party-table-row');
      if (!row) return;
      const id = parseInt(row.dataset.id ?? '', 10);
      if (Number.isNaN(id)) return;

      const actionBtn = target.closest<HTMLElement>('[data-action]');
      const action = actionBtn?.getAttribute('data-action');

      // Клик по строке — открыть диалог редактирования
      if (!actionBtn) {
        const data = await fetchPartyItems();
        const item = data.items.find((i) => i.id === id);
        if (item) partyDialog.openForEdit(item);
      }
    });

    const countersContainer = this.querySelector('#counters-container');
    countersContainer?.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const row = target.closest<HTMLElement>('.counter-table-row');
      const actionBtn = target.closest<HTMLElement>('[data-action]');
      const action = actionBtn?.getAttribute('data-action');

      if (action === 'toggle' && row) {
        const encodedId = row.getAttribute('data-id');
        if (!encodedId) return;
        const id = decodeURIComponent(encodedId);
        try {
          await toggleCounter(id);
          await this.loadCounters();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
        return;
      }

      if (action === 'edit' && row) {
        const encodedId = row.getAttribute('data-id');
        if (!encodedId) return;
        const id = decodeURIComponent(encodedId);
        try {
          const data = await fetchCounters();
          const counter = data.counters.find((c) => c.id === id);
          if (!counter) {
            showAlert('Счётчик не найден', 'error');
            return;
          }
          counterDialog.openForEdit(counter);
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка загрузки счётчика: ${error.message}`, 'error');
        }
        return;
      }

      if (row && !actionBtn) {
        const encodedId = row.getAttribute('data-id');
        if (!encodedId) return;
        const id = decodeURIComponent(encodedId);
        try {
          const data = await fetchCounters();
          const counter = data.counters.find((c) => c.id === id);
          if (!counter) return;
          counterDialog.openForEdit(counter);
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка загрузки счётчика: ${error.message}`, 'error');
        }
      }
    });

    counterDialog.addEventListener('save', async (event: Event) => {
      const customEvent = event as CustomEvent<CounterDialogSaveDetail>;
      const { counter, editId } = customEvent.detail;
      try {
        if (editId) {
          await updateCounter(editId, counter);
        } else {
          await createCounter(counter);
        }
        counterDialog.close();
        await this.loadCounters();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    counterDialog.addEventListener('delete', async (event: Event) => {
      const customEvent = event as CustomEvent<CounterDialogDeleteDetail>;
      const { id } = customEvent.detail;
      if (!id) return;
      if (!confirm('Удалить счётчик?')) return;
      try {
        await deleteCounter(id);
        counterDialog.close();
        await this.loadCounters();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    allLinksBtn.addEventListener('click', async () => {
      try {
        const config = await fetchLinksConfig();
        linkDialog.open({
          allLinksText: config.allLinksText ?? '',
        });
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка загрузки ссылок: ${error.message}`, 'error');
      }
    });

    commandsContainer.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const row = target.closest<HTMLElement>('.command-table-row');
      if (!row) return;
      const encodedId = row.getAttribute('data-id');
      if (!encodedId) return;
      const id = decodeURIComponent(encodedId);
      const actionEl = target.closest<HTMLElement>('[data-action]');
      const action = actionEl?.getAttribute('data-action');

      if (action === 'toggle') {
        try {
          await toggleCommand(id);
          await this.loadCommands();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
        return;
      }

      if (action === 'toggle-rotation') {
        try {
          await toggleCommandRotation(id);
          await this.loadCommands();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
        return;
      }

      if (action === 'send') {
        if (row.classList.contains('disabled')) {
          showAlert('Команда выключена. Включи её, чтобы отправить в чат.', 'error');
          return;
        }
        try {
          const res = await fetch(`/api/commands/${encodeURIComponent(id)}/send`, { method: 'POST' });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
          }
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка отправки команды: ${error.message}`, 'error');
        }
        return;
      }

      const triggerTextEl = row.querySelector('.trigger-text');
      if (triggerTextEl && triggerTextEl.contains(target)) {
        const text = triggerTextEl.textContent?.trim() ?? '';
        if (text) {
          try {
            await navigator.clipboard.writeText(text);
            showAlert('Триггер скопирован');
          } catch {
            showAlert('Не удалось скопировать', 'error');
          }
        }
        return;
      }

      if (!actionEl) {
        try {
          const data = await fetchCommands();
          const command = data.commands.find((cmd) => cmd.id === id);
          if (!command) {
            showAlert('Команда не найдена', 'error');
            return;
          }
          commandDialog.openForEdit(command);
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка загрузки команды: ${error.message}`, 'error');
        }
      }
    });

    commandDialog.addEventListener('delete', async (event: Event) => {
      const customEvent = event as CustomEvent<{ editId: string }>;
      const editId = customEvent.detail?.editId;
      if (!editId) return;
      try {
        await deleteCommand(editId);
        commandDialog.close();
        await this.loadCommands();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    commandDialog.addEventListener('save', async (event: Event) => {
      const customEvent = event as CustomEvent<CommandDialogSaveDetail>;
      const { command, editId } = customEvent.detail;
      try {
        if (editId) {
          await updateCommand(editId, command as CustomCommand);
        } else {
          await createCommand(command as CustomCommand);
        }
        commandDialog.close();
        await this.loadCommands();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    linkDialog.addEventListener('save', async (event: Event) => {
      const customEvent = event as CustomEvent<LinkDialogSaveDetail>;
      const { allLinksText } = customEvent.detail;
      try {
        await updateLinksConfig({ allLinksText });
        linkDialog.close();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка сохранения ссылок: ${error.message}`, 'error');
      }
    });

    linkDialog.addEventListener('send', async () => {
      try {
        await fetch('/api/links/send', { method: 'POST' });
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка отправки ссылок: ${error.message}`, 'error');
      }
    });

    const duelsToggle = this.querySelector('#duels-toggle');
    const pardonAllBtn = this.querySelector('#pardon-all-btn');

    duelsToggle?.addEventListener('click', async () => {
      const enabled = (duelsToggle as HTMLElement).getAttribute('data-enabled') === 'true';
      const endpoint = enabled ? '/api/admin/duels/disable' : '/api/admin/duels/enable';
      try {
        const res = await fetch(endpoint, { method: 'POST' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
        await this.loadDuelsStatus();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    const duelsCooldownToggle = this.querySelector('#duels-cooldown-toggle');
    duelsCooldownToggle?.addEventListener('click', async () => {
      const skipCooldown = (duelsCooldownToggle as HTMLElement).getAttribute('data-skip-cooldown') === 'true';
      const newSkip = !skipCooldown;
      try {
        const res = await fetch('/api/admin/duels/set-cooldown-skip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skip: newSkip }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
        await this.loadDuelsStatus();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    const duelConfigSaveBtn = this.querySelector('#duel-config-save-btn');
    const duelTimeoutInput = this.querySelector('#duel-timeout-min');
    const duelWinInput = this.querySelector('#duel-win-points');
    const duelLossInput = this.querySelector('#duel-loss-points');
    const duelMissPenaltyInput = this.querySelector('#duel-miss-penalty');
    [duelTimeoutInput, duelWinInput, duelLossInput, duelMissPenaltyInput].forEach((el) => {
      el?.addEventListener('input', () => this.updateDuelConfigSaveButton());
      el?.addEventListener('change', () => this.updateDuelConfigSaveButton());
    });
    const dailyGamesInput = this.querySelector('#daily-games-count');
    const dailyRewardInput = this.querySelector('#daily-reward-points');
    const streakWinsInput = this.querySelector('#streak-wins-count');
    const streakRewardInput = this.querySelector('#streak-reward-points');
    [dailyGamesInput, dailyRewardInput, streakWinsInput, streakRewardInput].forEach((el) => {
      el?.addEventListener('input', () => {
        this.updateDuelDailySaveButton();
        this.updateDuelDailyBlockDescriptions();
      });
      el?.addEventListener('change', () => {
        this.updateDuelDailySaveButton();
        this.updateDuelDailyBlockDescriptions();
      });
    });
    duelConfigSaveBtn?.addEventListener('click', async () => {
      const { timeoutMinutes, winPoints, lossPoints, missPenalty } = this.getDuelConfigFromInputs();
      if (timeoutMinutes < 0 || winPoints < 0 || lossPoints < 0 || missPenalty < 0) {
        showAlert('Введите неотрицательные числа', 'error');
        return;
      }
      try {
        const res = await fetch('/api/admin/duels/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timeoutMinutes, winPoints, lossPoints, missPenalty }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
        await this.loadDuelConfig();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    const duelDailySaveBtn = this.querySelector('#duel-daily-save-btn');
    duelDailySaveBtn?.addEventListener('click', async () => {
      const { dailyGamesCount, dailyRewardPoints, streakWinsCount, streakRewardPoints } = this.getDuelDailyFromInputs();
      if (dailyGamesCount < 0 || dailyRewardPoints < 0 || streakWinsCount < 0 || streakRewardPoints < 0) {
        showAlert('Введите неотрицательные числа', 'error');
        return;
      }
      try {
        const res = await fetch('/api/admin/duels/daily-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dailyGamesCount, dailyRewardPoints, streakWinsCount, streakRewardPoints }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
        await this.loadDuelDailyConfig();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    const duelResetRewardFlagsBtn = this.querySelector('#duel-reset-reward-flags-btn');
    duelResetRewardFlagsBtn?.addEventListener('click', async () => {
      if (!confirm('Сбросить у всех игроков флаги и счётчики наград (победы за день, серия побед)? Нужно для теста.')) return;
      try {
        const res = await fetch('/api/admin/duels/reset-reward-flags', { method: 'POST' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    const duelResetPointsBtn = this.querySelector('#duel-reset-points-btn');
    duelResetPointsBtn?.addEventListener('click', async () => {
      if (!confirm('Назначить всем игрокам по 1000 очков? Это нельзя отменить.')) return;
      try {
        const res = await fetch('/api/admin/duels/reset-points', { method: 'POST' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    pardonAllBtn?.addEventListener('click', async () => {
      if (!confirm('Простить всех игроков (снять таймауты дуэлей)?')) return;
      try {
        const res = await fetch('/api/admin/pardon-all', { method: 'POST' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
        await this.loadDuelBannedList();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    // Ротация ссылок — блок "Инфо"
    const linksIntervalInput = this.querySelector<HTMLInputElement>('#links-rotation-interval-min');
    const linksSaveBtn = this.querySelector<HTMLButtonElement>('#links-rotation-save-btn');

    const updateLinksSaveButton = () => {
      if (!linksIntervalInput || !linksSaveBtn) return;
      const current = parseInt(linksIntervalInput.value, 10) || 0;
      const same = this.lastLinksRotationMinutes !== null && this.lastLinksRotationMinutes === current;
      linksSaveBtn.disabled = same || current <= 0;
    };

    linksIntervalInput?.addEventListener('input', updateLinksSaveButton);
    linksIntervalInput?.addEventListener('change', updateLinksSaveButton);

    linksSaveBtn?.addEventListener('click', async () => {
      if (!linksIntervalInput) return;
      const raw = parseInt(linksIntervalInput.value, 10) || 0;
      const safeMinutes = Math.max(1, Math.min(120, raw));
      try {
        const config = await fetchLinksConfig();
        const updated = await updateLinksConfig({
          allLinksText: config.allLinksText ?? '',
          rotationIntervalMinutes: safeMinutes,
        });
        this.lastLinksRotationMinutes = updated.rotationIntervalMinutes ?? safeMinutes;
        linksIntervalInput.value = String(this.lastLinksRotationMinutes);
        updateLinksSaveButton();
        showAlert('Интервал ротации ссылок сохранён', 'success');
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка сохранения интервала ротации: ${error.message}`, 'error');
      }
    });

    const duelsBannedContainer = this.querySelector('#duels-banned-container');
    duelsBannedContainer?.addEventListener('click', async (event: Event) => {
      const target = event.target as HTMLElement;
      const btn = target.closest<HTMLElement>('[data-action="pardon-one"]');
      if (!btn) return;
      const row = btn.closest<HTMLElement>('.duel-banned-row');
      const username = row?.getAttribute('data-username');
      if (!username) return;
      try {
        const res = await fetch(`/api/admin/duels/pardon/${encodeURIComponent(username)}`, { method: 'POST' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
        await this.loadDuelBannedList();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'admin-panel': AdminPanelElement;
  }
}

customElements.define('admin-panel', AdminPanelElement);
