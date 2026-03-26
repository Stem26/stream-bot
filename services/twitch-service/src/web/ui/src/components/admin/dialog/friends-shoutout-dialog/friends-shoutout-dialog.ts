// @ts-ignore
import template from './friends-shoutout-dialog.html?raw';
import './friends-shoutout-dialog.scss';
import { createModal } from '../../../../utils/modal';
import { fetchFriendsShoutoutConfig, updateFriendsShoutoutConfig } from '../../../../api';
import { showAlert } from '../../../../alerts';

export interface FriendsShoutoutDialogElement extends HTMLElement {
  open(): void;
  close(): void;
}

export class FriendsShoutoutDialogElement extends HTMLElement {
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

    const form = this.querySelector<HTMLFormElement>('#friends-shoutout-form');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const textarea = this.querySelector<HTMLTextAreaElement>('#friends-shoutout-text');
      const text = textarea?.value ?? '';
      const logins = text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);

      try {
        const current = await fetchFriendsShoutoutConfig().catch(() => ({ enabled: false, logins: [] }));
        await updateFriendsShoutoutConfig({ enabled: Boolean(current.enabled), logins });
        showAlert('Список друзей-стримеров сохранён', 'success');
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
      const cfg = await fetchFriendsShoutoutConfig();
      const textarea = this.querySelector<HTMLTextAreaElement>('#friends-shoutout-text');
      if (textarea) textarea.value = (cfg.logins ?? []).join('\n');
    } catch {
      const textarea = this.querySelector<HTMLTextAreaElement>('#friends-shoutout-text');
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
    'friends-shoutout-dialog': FriendsShoutoutDialogElement;
  }
}

customElements.define('friends-shoutout-dialog', FriendsShoutoutDialogElement);

