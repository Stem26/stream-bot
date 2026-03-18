// @ts-ignore
import template from './party-table.html?raw';
import './party-table.scss';
import { showAlert } from '../../../../alerts';
import { fetchPartyItems, createPartyItem, updatePartyItem, deletePartyItem, fetchPartyConfig, updatePartyConfig, setPartySkipCooldown } from '../../../../api';
import type { PartyItemsData } from '../../../../types';
import type { PartyDialogElement, PartyDialogSaveDetail } from '../../dialog/party-dialog/party-dialog';
import { getAdminPassword } from '../../../../admin-auth';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

type PartyConfigValues = { trigger: string; responseText: string; elementsCount: number; quantityMax: number };

export class PartyTableElement extends HTMLElement {
  private initialized = false;
  private lastPartyConfig: PartyConfigValues | null = null;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.setupHandlers();
    if (getAdminPassword()) {
      void this.loadPartyItems();
      void this.loadPartyConfig();
    }
    window.addEventListener('admin-auth-success', this.handleAuthSuccess);
  }

  disconnectedCallback(): void {
    window.removeEventListener('admin-auth-success', this.handleAuthSuccess);
  }

  private handleAuthSuccess = (): void => {
    void this.loadPartyItems();
    void this.loadPartyConfig();
  };

  private setupHandlers(): void {
    const partyDialog = document.querySelector<PartyDialogElement>('party-dialog');
    if (!partyDialog) return;

    this.querySelector('#add-party-item-btn')?.addEventListener('click', () => partyDialog.openForCreate());

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
        if (textEl) textEl.textContent = newVal ? 'ВЫКЛ' : 'ВКЛ';
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    const partyEnabledToggle = this.querySelector('#party-enabled-toggle');
    partyEnabledToggle?.addEventListener('click', async () => {
      const on = (partyEnabledToggle as HTMLElement).getAttribute('data-enabled') === 'true';
      const newVal = !on;
      (partyEnabledToggle as HTMLElement).setAttribute('data-enabled', String(newVal));
      partyEnabledToggle.classList.toggle('on', newVal);
      partyEnabledToggle.classList.toggle('off', !newVal);
      const textEl = partyEnabledToggle.querySelector('.status-toggle-text');
      if (textEl) textEl.textContent = newVal ? 'ВКЛ' : 'ВЫКЛ';
      try {
        const triggerInput = this.querySelector('#party-trigger') as HTMLInputElement;
        const responseTextInput = this.querySelector('#party-response-text') as HTMLInputElement;
        const ec = this.querySelector('#party-elements-count') as HTMLInputElement;
        const qm = this.querySelector('#party-quantity-max') as HTMLInputElement;
        const skipToggle = this.querySelector('#party-skip-cooldown-toggle');
        const trigger = (triggerInput?.value ?? '!партия').trim() || '!партия';
        const responseText = (responseTextInput?.value ?? 'Партия выдала').trim() || 'Партия выдала';
        const elementsCount = Math.min(10, Math.max(1, parseInt(ec?.value || '2', 10) || 2));
        const quantityMax = Math.min(99, Math.max(1, parseInt(qm?.value || '4', 10) || 4));
        const skipCooldown = (skipToggle as HTMLElement)?.getAttribute('data-enabled') === 'true';
        await updatePartyConfig({ enabled: newVal, trigger: trigger.startsWith('!') ? trigger : `!${trigger}`, responseText, elementsCount, quantityMax, skipCooldown: skipCooldown ?? false });
      } catch (error) {
        (partyEnabledToggle as HTMLElement).setAttribute('data-enabled', String(on));
        partyEnabledToggle.classList.toggle('on', on);
        partyEnabledToggle.classList.toggle('off', !on);
        if (textEl) textEl.textContent = on ? 'ВКЛ' : 'ВЫКЛ';
        if (error instanceof Error) showAlert(`Ошибка сохранения: ${error.message}`, 'error');
      }
    });

    const partyConfigSaveBtn = this.querySelector('#party-config-save-btn');
    const updatePartySaveButton = (): void => {
      if (!partyConfigSaveBtn || !this.lastPartyConfig) return;
      const triggerInput = this.querySelector('#party-trigger') as HTMLInputElement;
      const responseTextInput = this.querySelector('#party-response-text') as HTMLInputElement;
      const ec = this.querySelector('#party-elements-count') as HTMLInputElement;
      const qm = this.querySelector('#party-quantity-max') as HTMLInputElement;
      const current: PartyConfigValues = {
        trigger: (triggerInput?.value ?? '!партия').trim() || '!партия',
        responseText: (responseTextInput?.value ?? 'Партия выдала').trim() || 'Партия выдала',
        elementsCount: Math.min(10, Math.max(1, parseInt(ec?.value || '2', 10) || 2)),
        quantityMax: Math.min(99, Math.max(1, parseInt(qm?.value || '4', 10) || 4)),
      };
      (partyConfigSaveBtn as HTMLButtonElement).disabled = current.trigger === this.lastPartyConfig.trigger && current.responseText === this.lastPartyConfig.responseText && current.elementsCount === this.lastPartyConfig.elementsCount && current.quantityMax === this.lastPartyConfig.quantityMax;
    };

    [this.querySelector('#party-trigger'), this.querySelector('#party-response-text'), this.querySelector('#party-elements-count'), this.querySelector('#party-quantity-max')].forEach((el) => el?.addEventListener('input', updatePartySaveButton));

    partyConfigSaveBtn?.addEventListener('click', async () => {
      const triggerInput = this.querySelector('#party-trigger') as HTMLInputElement;
      const responseTextInput = this.querySelector('#party-response-text') as HTMLInputElement;
      const ec = this.querySelector('#party-elements-count') as HTMLInputElement;
      const qm = this.querySelector('#party-quantity-max') as HTMLInputElement;
      const enabled = (this.querySelector('#party-enabled-toggle') as HTMLElement)?.getAttribute('data-enabled') === 'true';
      const trigger = (triggerInput?.value ?? '!партия').trim() || '!партия';
      const responseText = (responseTextInput?.value ?? 'Партия выдала').trim() || 'Партия выдала';
      const elementsCount = Math.min(10, Math.max(1, parseInt(ec?.value || '2', 10) || 2));
      const quantityMax = Math.min(99, Math.max(1, parseInt(qm?.value || '4', 10) || 4));
      try {
        const toggle = this.querySelector('#party-skip-cooldown-toggle');
        const skipCooldown = (toggle as HTMLElement)?.getAttribute('data-enabled') === 'true';
        const saved = await updatePartyConfig({ enabled: enabled ?? true, trigger: trigger.startsWith('!') ? trigger : `!${trigger}`, responseText, elementsCount, quantityMax, skipCooldown: skipCooldown ?? false });
        this.lastPartyConfig = { trigger: saved.trigger ?? trigger, responseText: saved.responseText ?? responseText, elementsCount: saved.elementsCount ?? elementsCount, quantityMax: saved.quantityMax ?? quantityMax };
        updatePartySaveButton();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    partyDialog.addEventListener('save', async (event: Event) => {
      const { editId, text } = (event as CustomEvent<PartyDialogSaveDetail>).detail;
      try {
        if (editId != null) await updatePartyItem(editId, text);
        else await createPartyItem(text);
        partyDialog.close();
        await this.loadPartyItems();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    partyDialog.addEventListener('delete', async (event: Event) => {
      const editId = (event as CustomEvent<{ editId: number }>).detail?.editId;
      if (editId == null) return;
      try {
        await deletePartyItem(editId);
        partyDialog.close();
        await this.loadPartyItems();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    this.querySelector('#party-items-container')?.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement;
      const row = target.closest<HTMLElement>('.party-table-row');
      if (!row) return;
      const id = parseInt(row.dataset.id ?? '', 10);
      if (Number.isNaN(id)) return;
      if (target.closest<HTMLElement>('[data-action]')) return;
      const data = await fetchPartyItems();
      const item = data.items.find((i) => i.id === id);
      if (item) partyDialog.openForEdit(item);
    });
  }

  private renderPartyItems(data: PartyItemsData): void {
    const container = this.querySelector<HTMLElement>('#party-items-container');
    if (!container) return;
    container.innerHTML = '';
    container.classList.remove('loading-state');
    const table = document.createElement('table');
    table.className = 'party-items-table';
    table.innerHTML = '<thead><tr><th class="col-num">№</th><th class="col-name">Название</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody')!;
    const sorted = [...data.items].sort((a, b) => a.text.localeCompare(b.text, 'ru'));
    sorted.forEach((item, index) => {
      const tr = document.createElement('tr');
      tr.className = 'party-table-row';
      tr.dataset.id = String(item.id);
      tr.innerHTML = `<td class="col-num">${index + 1}</td><td class="col-name" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</td>`;
      tbody.appendChild(tr);
    });
    container.appendChild(table);
  }

  private async loadPartyItems(): Promise<void> {
    try {
      const data = await fetchPartyItems();
      this.renderPartyItems(data);
    } catch (error) {
      if (error instanceof Error) showAlert(`Ошибка загрузки партии: ${error.message}`, 'error');
    }
  }

  private async loadPartyConfig(): Promise<void> {
    try {
      const config = await fetchPartyConfig();
      const normalized: PartyConfigValues = {
        trigger: ((config.trigger ?? '!партия').trim() || '!партия').startsWith('!') ? (config.trigger ?? '!партия').trim() || '!партия' : `!${(config.trigger ?? '!партия').trim() || '!партия'}`,
        responseText: (config.responseText ?? 'Партия выдала').trim() || 'Партия выдала',
        elementsCount: Math.min(10, Math.max(1, config.elementsCount || 2)),
        quantityMax: Math.min(99, Math.max(1, config.quantityMax || 4)),
      };
      this.lastPartyConfig = normalized;
      const triggerInput = this.querySelector('#party-trigger');
      const responseTextInput = this.querySelector('#party-response-text');
      const ec = this.querySelector('#party-elements-count');
      const qm = this.querySelector('#party-quantity-max');
      if (triggerInput) (triggerInput as HTMLInputElement).value = normalized.trigger;
      if (responseTextInput) (responseTextInput as HTMLInputElement).value = normalized.responseText;
      if (ec) (ec as HTMLInputElement).value = String(normalized.elementsCount);
      if (qm) (qm as HTMLInputElement).value = String(normalized.quantityMax);
      const enabledToggle = this.querySelector('#party-enabled-toggle');
      if (enabledToggle) {
        const on = config.enabled !== false;
        enabledToggle.classList.toggle('on', on);
        enabledToggle.classList.toggle('off', !on);
        enabledToggle.setAttribute('data-enabled', String(on));
        const textEl = enabledToggle.querySelector('.status-toggle-text');
        if (textEl) textEl.textContent = on ? 'ВКЛ' : 'ВЫКЛ';
      }
      const toggle = this.querySelector('#party-skip-cooldown-toggle');
      if (toggle) {
        const on = config.skipCooldown;
        toggle.classList.toggle('on', on);
        toggle.classList.toggle('off', !on);
        toggle.setAttribute('data-enabled', String(on));
        const textEl = toggle.querySelector('.status-toggle-text');
        if (textEl) textEl.textContent = on ? 'ВЫКЛ' : 'ВКЛ';
      }
      const partyConfigSaveBtn = this.querySelector('#party-config-save-btn');
      if (partyConfigSaveBtn) (partyConfigSaveBtn as HTMLButtonElement).disabled = true;
    } catch (error) {
      if (error instanceof Error) showAlert(`Ошибка загрузки настроек партии: ${error.message}`, 'error');
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'party-table': PartyTableElement;
  }
}

customElements.define('party-table', PartyTableElement);
