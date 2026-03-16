// @ts-ignore
import template from './moderation-table.html?raw';
import './moderation-table.scss';
import { showAlert } from '../../../../alerts';
import { fetchChatModerationConfig, updateChatModerationConfig } from '../../../../api';
import type { ChatModerationConfig } from '../../../../types';
import type { ModerationRulesDialogElement } from '../../dialog/moderation-rules-dialog/moderation-rules-dialog';
import type { LinkWhitelistDialogElement } from '../../dialog/link-whitelist-dialog/link-whitelist-dialog';
import { getAdminPassword } from '../../../../admin-auth';

export class ModerationTableElement extends HTMLElement {
  private initialized = false;
  private lastChatModerationConfig: ChatModerationConfig | null = null;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.setupHandlers();
    if (getAdminPassword()) void this.loadChatModerationConfig();
    window.addEventListener('admin-auth-success', this.handleAuthSuccess);
  }

  disconnectedCallback(): void {
    window.removeEventListener('admin-auth-success', this.handleAuthSuccess);
  }

  private handleAuthSuccess = (): void => {
    void this.loadChatModerationConfig();
  };

  private setModerationToggleState(el: HTMLElement | null, on: boolean, text: string): void {
    if (!el) return;
    el.classList.toggle('on', on);
    el.classList.toggle('off', !on);
    el.setAttribute('data-enabled', String(on));
    const textEl = el.querySelector('.status-toggle-text');
    if (textEl) textEl.textContent = text;
  }

  private setupHandlers(): void {
    const maxLenInput = this.querySelector('#chat-max-length') as HTMLInputElement | null;
    const maxLettersDigitsInput = this.querySelector('#chat-max-letters-digits') as HTMLInputElement | null;
    const timeoutInput = this.querySelector('#chat-spam-timeout-min') as HTMLInputElement | null;
    const moderationSaveBtn = this.querySelector('#chat-moderation-save-btn') as HTMLButtonElement | null;
    const moderationEnabledToggle = this.querySelector('#chat-moderation-enabled-toggle') as HTMLElement | null;
    const checkSymbolsToggle = this.querySelector('#chat-check-symbols-toggle') as HTMLElement | null;
    const checkLettersToggle = this.querySelector('#chat-check-letters-toggle') as HTMLElement | null;
    const checkLinksToggle = this.querySelector('#chat-check-links-toggle') as HTMLElement | null;

    const touchModerationDirty = (): void => { if (moderationSaveBtn) moderationSaveBtn.disabled = false; };

    const saveModerationNow = async (): Promise<void> => {
      if (!maxLenInput || !maxLettersDigitsInput || !timeoutInput) return;
      const moderationEnabled = moderationEnabledToggle?.getAttribute('data-enabled') === 'true';
      const checkSymbols = checkSymbolsToggle?.getAttribute('data-enabled') === 'true';
      const checkLetters = checkLettersToggle?.getAttribute('data-enabled') === 'true';
      const checkLinks = checkLinksToggle?.getAttribute('data-enabled') === 'true';
      const maxMessageLength = Math.max(1, parseInt(maxLenInput.value || String(this.lastChatModerationConfig?.maxMessageLength ?? 300), 10) || (this.lastChatModerationConfig?.maxMessageLength ?? 300));
      const maxLettersDigits = Math.max(1, parseInt(maxLettersDigitsInput.value || String(this.lastChatModerationConfig?.maxLettersDigits ?? 300), 10) || (this.lastChatModerationConfig?.maxLettersDigits ?? 300));
      const timeoutMinutes = Math.max(1, parseInt(timeoutInput.value || String(this.lastChatModerationConfig?.timeoutMinutes ?? 10), 10) || (this.lastChatModerationConfig?.timeoutMinutes ?? 10));
      try {
        const saved = await updateChatModerationConfig({ moderationEnabled, checkSymbols: moderationEnabled ? checkSymbols : false, checkLetters: moderationEnabled ? checkLetters : false, checkLinks: moderationEnabled ? checkLinks : false, maxMessageLength, maxLettersDigits, timeoutMinutes });
        this.lastChatModerationConfig = saved;
      } catch (error) { if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error'); }
    };

    moderationEnabledToggle?.addEventListener('click', () => {
      const on = moderationEnabledToggle.getAttribute('data-enabled') === 'true';
      const newVal = !on;
      this.setModerationToggleState(moderationEnabledToggle, newVal, newVal ? 'ВКЛ' : 'ВЫКЛ');
      if (!newVal) {
        this.setModerationToggleState(checkSymbolsToggle, false, 'ВЫКЛ');
        this.setModerationToggleState(checkLettersToggle, false, 'ВЫКЛ');
        this.setModerationToggleState(checkLinksToggle, false, 'ВЫКЛ');
      }
      void saveModerationNow();
    });

    checkSymbolsToggle?.addEventListener('click', () => {
      if (moderationEnabledToggle?.getAttribute('data-enabled') !== 'true') return;
      const on = checkSymbolsToggle.getAttribute('data-enabled') === 'true';
      this.setModerationToggleState(checkSymbolsToggle, !on, !on ? 'ВКЛ' : 'ВЫКЛ');
      void saveModerationNow();
    });

    checkLettersToggle?.addEventListener('click', () => {
      if (moderationEnabledToggle?.getAttribute('data-enabled') !== 'true') return;
      const on = checkLettersToggle.getAttribute('data-enabled') === 'true';
      this.setModerationToggleState(checkLettersToggle, !on, !on ? 'ВКЛ' : 'ВЫКЛ');
      void saveModerationNow();
    });

    checkLinksToggle?.addEventListener('click', () => {
      if (moderationEnabledToggle?.getAttribute('data-enabled') !== 'true') return;
      const on = checkLinksToggle.getAttribute('data-enabled') === 'true';
      this.setModerationToggleState(checkLinksToggle, !on, !on ? 'ВКЛ' : 'ВЫКЛ');
      void saveModerationNow();
    });

    this.querySelector('#chat-link-whitelist-btn')?.addEventListener('click', () => {
      const dialog = document.querySelector('link-whitelist-dialog') as LinkWhitelistDialogElement | null;
      void dialog?.open();
    });

    maxLenInput?.addEventListener('input', touchModerationDirty);
    maxLettersDigitsInput?.addEventListener('input', touchModerationDirty);
    timeoutInput?.addEventListener('input', touchModerationDirty);

    moderationSaveBtn?.addEventListener('click', async () => {
      if (!maxLenInput || !maxLettersDigitsInput || !timeoutInput) return;
      const moderationEnabled = moderationEnabledToggle?.getAttribute('data-enabled') === 'true';
      const checkSymbols = checkSymbolsToggle?.getAttribute('data-enabled') === 'true';
      const checkLetters = checkLettersToggle?.getAttribute('data-enabled') === 'true';
      const checkLinks = checkLinksToggle?.getAttribute('data-enabled') === 'true';
      const maxMessageLength = Math.max(1, parseInt(maxLenInput.value || '300', 10) || 300);
      const maxLettersDigits = Math.max(1, parseInt(maxLettersDigitsInput.value || '300', 10) || 300);
      const timeoutMinutes = Math.max(1, parseInt(timeoutInput.value || '10', 10) || 10);
      try {
        const saved = await updateChatModerationConfig({ moderationEnabled, checkSymbols: moderationEnabled ? checkSymbols : false, checkLetters: moderationEnabled ? checkLetters : false, checkLinks: moderationEnabled ? checkLinks : false, maxMessageLength, maxLettersDigits, timeoutMinutes });
        this.lastChatModerationConfig = saved;
        if (moderationSaveBtn) moderationSaveBtn.disabled = true;
        showAlert('Настройки модерации чата сохранены', 'success');
      } catch (error) { if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error'); }
    });

    this.querySelector('#chat-moderation-rules-btn')?.addEventListener('click', () => {
      const dialog = document.querySelector('moderation-rules-dialog') as ModerationRulesDialogElement | null;
      dialog?.open(this.lastChatModerationConfig ?? undefined);
    });
  }

  private async loadChatModerationConfig(): Promise<void> {
    try {
      const config = await fetchChatModerationConfig();
      this.lastChatModerationConfig = config;
      const maxLenInput = this.querySelector('#chat-max-length') as HTMLInputElement | null;
      const maxLettersDigitsInput = this.querySelector('#chat-max-letters-digits') as HTMLInputElement | null;
      const timeoutInput = this.querySelector('#chat-spam-timeout-min') as HTMLInputElement | null;
      const saveBtn = this.querySelector('#chat-moderation-save-btn') as HTMLButtonElement | null;
      const moderationEnabledToggle = this.querySelector('#chat-moderation-enabled-toggle') as HTMLElement | null;
      const checkSymbolsToggle = this.querySelector('#chat-check-symbols-toggle') as HTMLElement | null;
      const checkLettersToggle = this.querySelector('#chat-check-letters-toggle') as HTMLElement | null;
      const checkLinksToggle = this.querySelector('#chat-check-links-toggle') as HTMLElement | null;
      if (maxLenInput) maxLenInput.value = String(config.maxMessageLength ?? 300);
      if (maxLettersDigitsInput) maxLettersDigitsInput.value = String(config.maxLettersDigits ?? 300);
      if (timeoutInput) timeoutInput.value = String(config.timeoutMinutes ?? 10);
      const modOn = config.moderationEnabled ?? true;
      const symOn = config.checkSymbols ?? true;
      const letOn = config.checkLetters ?? true;
      const linksOn = config.checkLinks ?? false;
      if (moderationEnabledToggle) this.setModerationToggleState(moderationEnabledToggle, modOn, modOn ? 'ВКЛ' : 'ВЫКЛ');
      if (checkSymbolsToggle) this.setModerationToggleState(checkSymbolsToggle, symOn, symOn ? 'ВКЛ' : 'ВЫКЛ');
      if (checkLettersToggle) this.setModerationToggleState(checkLettersToggle, letOn, letOn ? 'ВКЛ' : 'ВЫКЛ');
      if (checkLinksToggle) this.setModerationToggleState(checkLinksToggle, linksOn, linksOn ? 'ВКЛ' : 'ВЫКЛ');
      if (saveBtn) saveBtn.disabled = true;
    } catch (error) {
      if (error instanceof Error) showAlert(`Ошибка загрузки настроек модерации: ${error.message}`, 'error');
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'moderation-table': ModerationTableElement;
  }
}

customElements.define('moderation-table', ModerationTableElement);
