// @ts-ignore
import template from './link-whitelist-dialog.html?raw';
import './link-whitelist-dialog.scss';
import { createModal } from '../../../../utils/modal';
import { fetchLinkWhitelist, updateLinkWhitelist } from '../../../../api';
import { showAlert } from '../../../../alerts';

export interface LinkWhitelistDialogElement extends HTMLElement {
  open(): void;
  close(): void;
}

export class LinkWhitelistDialogElement extends HTMLElement {
  private initialized = false;
  private modal!: ReturnType<typeof createModal>;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.modal = createModal(() => this.querySelector('.modal'));

    this.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    const form = this.querySelector<HTMLFormElement>('#link-whitelist-form');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const textarea = this.querySelector<HTMLTextAreaElement>('#link-whitelist-text');
      const text = textarea?.value ?? '';
      const patterns = text
        .split(/\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        await updateLinkWhitelist(patterns);
        showAlert('Разрешённые ссылки сохранены', 'success');
        this.dispatchEvent(new CustomEvent('saved', { bubbles: true }));
        this.close();
      } catch (err) {
        showAlert(err instanceof Error ? err.message : 'Ошибка сохранения', 'error');
      }
    });
  }

  async open(): Promise<void> {
    this.ensureInit();
    try {
      const { patterns } = await fetchLinkWhitelist();
      const textarea = this.querySelector<HTMLTextAreaElement>('#link-whitelist-text');
      if (textarea) textarea.value = patterns.join('\n');
    } catch {
      const textarea = this.querySelector<HTMLTextAreaElement>('#link-whitelist-text');
      if (textarea) textarea.value = '';
    }
    this.modal.show();
  }

  close(): void {
    this.modal.hide();
  }

  private ensureInit(): void {
    if (!this.initialized) this.connectedCallback();
  }

  disconnectedCallback(): void {
    this.modal?.cleanup();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'link-whitelist-dialog': LinkWhitelistDialogElement;
  }
}

customElements.define('link-whitelist-dialog', LinkWhitelistDialogElement);
