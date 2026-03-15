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
import type { CounterDialogElement, CounterDialogSaveDetail } from '../counter-dialog/counter-dialog';
import type { PartyDialogElement, PartyDialogSaveDetail } from '../party-dialog/party-dialog';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class AdminPanelElement extends HTMLElement {
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.bootstrap().catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
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
    if (!container) return;

    container.style.display = 'grid';
    container.innerHTML = '';

    const variantsText = (t: string) => `${t}инфо · ${t}откат · ${t}[число]`;
    const addTpl = this.getTemplate('template-add-counter-card');
    const cardTpl = this.getTemplate('template-counter-card');
    if (addTpl) container.appendChild(addTpl.content.cloneNode(true));
    if (!cardTpl) return;

    for (const counter of data.counters) {
      const card = cardTpl.content.cloneNode(true) as DocumentFragment;
      const root = card.firstElementChild as HTMLElement;
      if (!root) continue;
      root.classList.toggle('disabled', !counter.enabled);
      root.dataset.id = encodeURIComponent(counter.id);
      const variants = variantsText(counter.trigger);
      (root.querySelector('.trigger-main') as HTMLElement).textContent = counter.trigger;
      const variantsEl = root.querySelector('.counter-variants') as HTMLElement;
      variantsEl.textContent = variants;
      variantsEl.title = variants;
      const toggle = root.querySelector('.status-toggle');
      toggle?.classList.toggle('on', counter.enabled);
      toggle?.classList.toggle('off', !counter.enabled);
      (toggle?.querySelector('.status-toggle-text') as HTMLElement).textContent = counter.enabled ? 'ВКЛ' : 'ВЫКЛ';
      const desc = root.querySelector('.counter-description-slot .command-description') as HTMLElement;
      if (desc) {
        desc.textContent = counter.description || '\u00A0';
        desc.classList.toggle('empty', !counter.description);
        if (counter.description) desc.title = counter.description;
      }
      (root.querySelector('.counter-value') as HTMLElement).textContent = String(counter.value);
      const templateEl = root.querySelector('.counter-template') as HTMLElement;
      const strong = document.createElement('strong');
      strong.textContent = 'Шаблон ответа: ';
      templateEl.appendChild(strong);
      templateEl.appendChild(document.createTextNode(counter.responseTemplate));
      templateEl.title = `Шаблон ответа: ${counter.responseTemplate}`;
      const aliasesEl = root.querySelector('.command-aliases');
      if (aliasesEl && counter.aliases?.length) {
        counter.aliases.forEach((alias) => {
          const tag = document.createElement('span');
          tag.className = 'alias-tag';
          tag.textContent = alias;
          aliasesEl.appendChild(tag);
        });
      }
      container.appendChild(card);
    }
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
      const data = (await response.json()) as { enabled?: boolean };
      const toggle = this.querySelector('#duels-toggle');
      if (toggle) {
        const enabled = Boolean(data.enabled);
        toggle.classList.toggle('on', enabled);
        toggle.classList.toggle('off', !enabled);
        toggle.setAttribute('data-enabled', String(enabled));
        const textEl = toggle.querySelector('.status-toggle-text');
        if (textEl) textEl.textContent = enabled ? 'ВКЛ' : 'ВЫКЛ';
      }
      return Boolean(data?.enabled);
    } catch (error) {
      console.error('Ошибка загрузки статуса дуэлей:', error);
      return false;
    }
  }

  private async initLinks(linkDialog: LinkDialogElement): Promise<void> {
    try {
      const config = await fetchLinksConfig();
      linkDialog.open(config.allLinksText ?? '');
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
    await this.loadPartyItems();
    await this.loadPartyConfig();

    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('#add-command-btn')) {
        commandDialog.openForCreate();
      } else if (target.closest('#add-counter-card-trigger')) {
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
      const card = target.closest<HTMLElement>('.counter-card');
      if (!card) return;
      const encodedId = card.getAttribute('data-id');
      if (!encodedId) return;
      const id = decodeURIComponent(encodedId);
      const actionEl = target.closest<HTMLElement>('[data-action]');
      const action = actionEl?.getAttribute('data-action');
      if (!action) return;

      if (action === 'toggle') {
        try {
          await toggleCounter(id);
          await this.loadCounters();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }

      if (action === 'edit-value') {
        const newValue = prompt('Введите новое значение счётчика:');
        if (newValue !== null) {
          const parsedValue = parseInt(newValue, 10);
          if (!isNaN(parsedValue)) {
            try {
              const data = await fetchCounters();
              const counter = data.counters.find((c) => c.id === id);
              if (!counter) {
                showAlert('Счётчик не найден', 'error');
                return;
              }
              await updateCounter(id, { ...counter, value: parsedValue });
              await this.loadCounters();
            } catch (error) {
              if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
            }
          } else {
            showAlert('Некорректное значение', 'error');
          }
        }
      }

      if (action === 'delete') {
        if (!confirm('Удалить счётчик?')) return;
        try {
          await deleteCounter(id);
          await this.loadCounters();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }

      if (action === 'edit') {
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

    allLinksBtn.addEventListener('click', async () => {
      try {
        const config = await fetchLinksConfig();
        linkDialog.open(config.allLinksText ?? '');
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
        await updateLinksConfig(allLinksText);
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

    pardonAllBtn?.addEventListener('click', async () => {
      if (!confirm('Простить всех игроков (снять таймауты дуэлей)?')) return;
      try {
        const res = await fetch('/api/admin/pardon-all', { method: 'POST' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
        }
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
