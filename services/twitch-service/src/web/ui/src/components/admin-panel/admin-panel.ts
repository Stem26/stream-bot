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
    if (!container || !emptyState) return;

    container.style.display = 'grid';
    emptyState.style.display = 'none';
    container.innerHTML = '';

    const addTpl = this.getTemplate('template-add-command-card');
    const cardTpl = this.getTemplate('template-command-card');
    if (addTpl) container.appendChild(addTpl.content.cloneNode(true));
    if (!cardTpl) return;

    for (const cmd of data.commands) {
      const card = cardTpl.content.cloneNode(true) as DocumentFragment;
      const root = card.firstElementChild as HTMLElement;
      if (!root) continue;
      root.classList.toggle('disabled', !cmd.enabled);
      root.dataset.id = encodeURIComponent(cmd.id);
      root.dataset.messageType = cmd.messageType;
      root.dataset.color = cmd.color ?? '';
      root.querySelector('.command-trigger')!.textContent = cmd.trigger;
      const colorBadge = root.querySelector('.command-status .color-badge') as HTMLElement;
      if (colorBadge) {
        if (cmd.messageType === 'announcement') {
          colorBadge.className = `color-badge ${cmd.color ?? 'primary'}`;
          colorBadge.textContent = cmd.color ?? 'primary';
        } else {
          colorBadge.className = 'color-badge';
          colorBadge.style.background = '#6c757d';
          colorBadge.textContent = 'сообщение';
        }
      }
      const toggle = root.querySelector('.status-toggle');
      toggle?.classList.toggle('on', cmd.enabled);
      toggle?.classList.toggle('off', !cmd.enabled);
      (toggle?.querySelector('.status-toggle-text') as HTMLElement).textContent = cmd.enabled ? 'ВКЛ' : 'ВЫКЛ';
      const desc = root.querySelector('.command-description') as HTMLElement;
      if (desc) {
        desc.textContent = cmd.description || '\u00A0';
        desc.classList.toggle('empty', !cmd.description);
        if (cmd.description) desc.title = cmd.description;
      }
      const response = root.querySelector('.command-response') as HTMLElement;
      if (response) {
        response.textContent = cmd.response;
        response.title = cmd.response;
      }
      const aliasesEl = root.querySelector('.command-aliases');
      if (aliasesEl && cmd.aliases?.length) {
        cmd.aliases.forEach((alias) => {
          const tag = document.createElement('span');
          tag.className = 'alias-tag';
          tag.textContent = alias;
          aliasesEl.appendChild(tag);
        });
      }
      const sendBtn = root.querySelector('[data-action="send"]') as HTMLButtonElement;
      if (sendBtn) sendBtn.disabled = !cmd.enabled;
      container.appendChild(card);
    }
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

    container.style.display = 'grid';
    container.innerHTML = '';

    const addTpl = this.getTemplate('template-add-party-card');
    const itemTpl = this.getTemplate('template-party-item');
    if (addTpl) container.appendChild(addTpl.content.cloneNode(true));
    if (!itemTpl) return;

    for (const item of data.items) {
      const card = itemTpl.content.cloneNode(true) as DocumentFragment;
      const root = card.firstElementChild as HTMLElement;
      if (!root) continue;
      root.dataset.id = String(item.id);
      const response = root.querySelector('.command-response') as HTMLElement;
      response.textContent = item.text;
      response.title = item.text;
      container.appendChild(card);
    }
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

    if (!allLinksBtn || !commandsContainer || !commandDialog || !linkDialog || !counterDialog) {
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
      if (target.closest('#add-command-card-trigger')) {
        commandDialog.openForCreate();
      } else if (target.closest('#add-counter-card-trigger')) {
        counterDialog.openForCreate();
      } else if (target.closest('#add-party-item-card-trigger')) {
        (async () => {
          const text = prompt('Элемент (например: хомяко‑адвоката):');
          if (!text?.trim()) return;
          try {
            await createPartyItem(text.trim());
            showAlert('Элемент добавлен');
            await this.loadPartyItems();
          } catch (error) {
            if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
          }
        })();
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
        showAlert(newVal ? 'Тестовый режим: кулдаун отключён' : 'Кулдаун включён (раз в сутки)');
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
        showAlert('Настройки сохранены');
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    const partyItemsContainer = this.querySelector('#party-items-container');
    partyItemsContainer?.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement;
      const card = target.closest<HTMLElement>('.party-item-card');
      if (!card) return;
      const id = parseInt(card.getAttribute('data-id') ?? '', 10);
      if (isNaN(id)) return;

      const action = target.closest<HTMLElement>('[data-action]')?.getAttribute('data-action');
      if (action === 'edit') {
        const data = await fetchPartyItems();
        const item = data.items.find((i) => i.id === id);
        if (!item) return;
        const text = prompt('Элемент:', item.text);
        if (text === null || !text.trim()) return;
        try {
          await updatePartyItem(id, text.trim());
          showAlert('Элемент обновлён');
          await this.loadPartyItems();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }
      if (action === 'delete') {
        if (!confirm('Удалить элемент?')) return;
        try {
          await deletePartyItem(id);
          showAlert('Элемент удалён');
          await this.loadPartyItems();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
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
          showAlert('Статус счётчика изменён');
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
              showAlert('Значение счётчика обновлено');
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
          showAlert('Счётчик удалён');
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
          showAlert('Счётчик обновлён');
        } else {
          await createCounter(counter);
          showAlert('Счётчик создан');
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
      const card = target.closest<HTMLElement>('.command-card');
      if (!card) return;
      const encodedId = card.getAttribute('data-id');
      if (!encodedId) return;
      const id = decodeURIComponent(encodedId);
      const messageType = card.getAttribute('data-message-type');
      const color = card.getAttribute('data-color');

      const copySource = target.closest<HTMLElement>('.command-trigger, .command-response, .alias-tag');
      if (copySource) {
        let textToCopy = copySource.textContent?.trim() ?? '';
        if (copySource.classList.contains('command-response') && messageType === 'announcement') {
          const colorSuffix = color && color !== 'primary' ? color : '';
          const announceCommand = colorSuffix ? `/announce${colorSuffix}` : '/announce';
          textToCopy = `${announceCommand} ${textToCopy}`;
        }
        if (textToCopy) {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(textToCopy);
            }
            showAlert('Текст скопирован в буфер обмена');
          } catch (error) {
            console.error('Clipboard copy failed', error);
          }
        }
        return;
      }

      const actionEl = target.closest<HTMLElement>('[data-action]');
      const action = actionEl?.getAttribute('data-action');

      if (!action) {
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
        return;
      }

      if (action === 'toggle') {
        try {
          await toggleCommand(id);
          await this.loadCommands();
          showAlert('Статус команды изменён');
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }

      if (action === 'send') {
        if (card.classList.contains('disabled')) {
          showAlert('Команда выключена. Включи её, чтобы отправить в чат.', 'error');
          return;
        }
        try {
          const res = await fetch(`/api/commands/${encodeURIComponent(id)}/send`, { method: 'POST' });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
          }
          showAlert('Команда отправлена в чат');
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка отправки команды: ${error.message}`, 'error');
        }
      }

      if (action === 'delete') {
        if (!confirm('Удалить команду?')) return;
        try {
          await deleteCommand(id);
          await this.loadCommands();
          showAlert('Команда удалена');
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }

      if (action === 'edit') {
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

    commandDialog.addEventListener('save', async (event: Event) => {
      const customEvent = event as CustomEvent<CommandDialogSaveDetail>;
      const { command, editId } = customEvent.detail;
      try {
        if (editId) {
          await updateCommand(editId, command as CustomCommand);
          showAlert('Команда обновлена');
        } else {
          await createCommand(command as CustomCommand);
          showAlert('Команда создана');
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
        showAlert('Ссылки сохранены');
        linkDialog.close();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка сохранения ссылок: ${error.message}`, 'error');
      }
    });

    linkDialog.addEventListener('send', async () => {
      try {
        await fetch('/api/links/send', { method: 'POST' });
        showAlert('Ссылки отправлены в чат');
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
        showAlert(enabled ? 'Дуэли выключены' : 'Дуэли включены');
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
        showAlert('Амнистия выполнена, все таймауты сняты');
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
