import template from './link-dialog.html?raw';
import './link-dialog.scss';

export interface LinkDialogSaveDetail {
  allLinksText: string;
}

export class LinkDialogElement extends HTMLElement {
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;

    this.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    const form = this.querySelector<HTMLFormElement>('#links-form');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const textarea = this.querySelector<HTMLTextAreaElement>('#all-links-text');
      const value = textarea?.value ?? '';
      this.dispatchEvent(
        new CustomEvent<LinkDialogSaveDetail>('save', {
          detail: { allLinksText: value },
          bubbles: true,
        }),
      );
    });
  }

  open(initialText: string): void {
    this.ensureInit();
    const textarea = this.querySelector<HTMLTextAreaElement>('#all-links-text');
    if (textarea) {
      textarea.value = initialText ?? '';
    }
    const modal = this.querySelector<HTMLElement>('.modal');
    modal?.classList.add('active');
    document.body.classList.add('modal-open');
  }

  close(): void {
    const modal = this.querySelector<HTMLElement>('.modal');
    modal?.classList.remove('active');
    document.body.classList.remove('modal-open');
  }

  private ensureInit(): void {
    if (!this.initialized) {
      this.connectedCallback();
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'link-dialog': LinkDialogElement;
  }
}

customElements.define('link-dialog', LinkDialogElement);

