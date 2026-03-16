// @ts-ignore
import template from './link-dialog.html?raw';
import './link-dialog.scss';
import { createModal } from '../../../../utils/modal';
import { substituteTimePlaceholders } from '../../../../utils/time-placeholders';

export interface LinkDialogSaveDetail {
  allLinksText: string;
}

export class LinkDialogElement extends HTMLElement {
  private initialized = false;
  private modal!: ReturnType<typeof createModal>;

  connectedCallback(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.innerHTML = template;
    this.modal = createModal(() => this.querySelector('.modal'));

    this.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    const form = this.querySelector<HTMLFormElement>('#links-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const textarea = this.querySelector<HTMLTextAreaElement>('#all-links-text');
      const value = textarea?.value ?? '';
      this.dispatchEvent(
        new CustomEvent<LinkDialogSaveDetail>('save', {
          detail: { allLinksText: value },
          bubbles: true,
        }),
      );
    });

    const sendBtn = this.querySelector<HTMLButtonElement>('[data-send]');
    sendBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      this.dispatchEvent(
        new CustomEvent<null>('send', {
          detail: null,
          bubbles: true,
        }),
      );
    });

    const textarea = this.querySelector<HTMLTextAreaElement>('#all-links-text');
    const counterEl = this.querySelector<HTMLElement>('#all-links-counter');
    const updateCounter = () => {
      const raw = textarea?.value ?? '';
      const effective = substituteTimePlaceholders(raw);
      if (counterEl) counterEl.textContent = `${effective.length} / 500`;
    };
    textarea?.addEventListener('input', updateCounter);
    textarea?.addEventListener('change', updateCounter);
  }

  open(config: { allLinksText: string }): void {
    this.ensureInit();
    const textarea = this.querySelector<HTMLTextAreaElement>('#all-links-text');
    if (textarea) textarea.value = config.allLinksText ?? '';
    this.updateLinksCounter();
    this.modal.show();
  }

  close(): void {
    this.modal.hide();
  }

  private updateLinksCounter(): void {
    const ta = this.querySelector<HTMLTextAreaElement>('#all-links-text');
    const counter = this.querySelector<HTMLElement>('#all-links-counter');
    const raw = ta?.value ?? '';
    const effective = substituteTimePlaceholders(raw);
    if (counter) counter.textContent = `${effective.length} / 500`;
  }

  private ensureInit(): void {
    if (!this.initialized) {
      this.connectedCallback();
    }
  }

  disconnectedCallback(): void {
    this.modal?.cleanup();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'link-dialog': LinkDialogElement;
  }
}

customElements.define('link-dialog', LinkDialogElement);

