import template from './party-dialog.html?raw';
import './party-dialog.scss';
import { createModal } from '../../utils/modal';
import type { PartyItem } from '../../types';

export interface PartyDialogSaveDetail {
  editId?: number;
  text: string;
}

export class PartyDialogElement extends HTMLElement {
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

    const form = this.querySelector<HTMLFormElement>('#party-item-form');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const detail = this.collectFormData();
      if (!detail) return;
      this.dispatchEvent(
        new CustomEvent<PartyDialogSaveDetail>('save', {
          detail,
          bubbles: true,
        }),
      );
    });
  }

  openForCreate(): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-party-item-id');
    const textInput = this.querySelector<HTMLInputElement>('#party-item-text');
    const form = this.querySelector<HTMLFormElement>('#party-item-form');

    if (modalTitle) modalTitle.textContent = 'Добавить элемент';
    form?.reset();
    if (editIdInput) editIdInput.value = '';
    if (textInput) textInput.placeholder = 'например: хомяко‑адвоката';
    this.open();
  }

  openForEdit(item: PartyItem): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-party-item-id');
    const textInput = this.querySelector<HTMLInputElement>('#party-item-text');

    if (modalTitle) modalTitle.textContent = 'Редактировать элемент';
    if (editIdInput) editIdInput.value = String(item.id);
    if (textInput) textInput.value = item.text;
    this.open();
  }

  close(): void {
    this.modal.hide();
  }

  private open(): void {
    this.modal.show();
  }

  private collectFormData(): PartyDialogSaveDetail | null {
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-party-item-id');
    const textInput = this.querySelector<HTMLInputElement>('#party-item-text');
    if (!textInput) return null;

    const text = textInput.value.trim();
    if (!text) return null;

    const editIdStr = editIdInput?.value.trim();
    const editId = editIdStr ? parseInt(editIdStr, 10) : undefined;
    if (editIdStr && Number.isNaN(editId)) return null;

    return { editId, text };
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
    'party-dialog': PartyDialogElement;
  }
}

customElements.define('party-dialog', PartyDialogElement);
