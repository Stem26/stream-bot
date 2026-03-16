// @ts-ignore
import template from './party-dialog.html?raw';
import './party-dialog.scss';
import { createModal } from '../../../../utils/modal';
import type { PartyItem } from '../../../../types';

export interface PartyDialogSaveDetail {
  editId?: number;
  text: string;
}

export class PartyDialogElement extends HTMLElement {
  private initialized = false;
  private modal!: ReturnType<typeof createModal>;
  private saveButton: HTMLButtonElement | null = null;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.modal = createModal(() => this.querySelector('.modal'));

    this.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    const deleteBtn = this.querySelector<HTMLButtonElement>('#party-delete-btn');
    deleteBtn?.addEventListener('click', () => {
      const editIdInput = this.querySelector<HTMLInputElement>('#edit-party-item-id');
      const editIdStr = editIdInput?.value?.trim();
      if (!editIdStr) return;
      const editId = parseInt(editIdStr, 10);
      if (Number.isNaN(editId)) return;
      if (!confirm('Удалить элемент?')) return;
      this.dispatchEvent(new CustomEvent('delete', { detail: { editId }, bubbles: true }));
    });

    const form = this.querySelector<HTMLFormElement>('#party-item-form');
    this.saveButton = this.querySelector<HTMLButtonElement>('.form-actions .btn.btn-success');
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

    const textInput = this.querySelector<HTMLInputElement>('#party-item-text');
    if (textInput) {
      textInput.addEventListener('blur', () => {
        const empty = !textInput.value.trim();
        textInput.classList.toggle('is-invalid', empty);
        this.validateForm();
      });
      textInput.addEventListener('input', () => {
        if (textInput.value.trim()) textInput.classList.remove('is-invalid');
        this.validateForm();
      });
    }

    this.validateForm();
  }

  openForCreate(): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-party-item-id');
    const textInput = this.querySelector<HTMLInputElement>('#party-item-text');
    const form = this.querySelector<HTMLFormElement>('#party-item-form');

    if (modalTitle) modalTitle.textContent = 'Добавить элемент';
    form?.reset();
    textInput?.classList.remove('is-invalid');
    if (editIdInput) editIdInput.value = '';
    if (textInput) textInput.placeholder = 'например: хомяко‑адвоката';
    const deleteBtn = this.querySelector<HTMLButtonElement>('#party-delete-btn');
    if (deleteBtn) deleteBtn.style.display = 'none';
    this.validateForm();
    this.open();
  }

  openForEdit(item: PartyItem): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-party-item-id');
    const textInput = this.querySelector<HTMLInputElement>('#party-item-text');

    if (modalTitle) modalTitle.textContent = 'Редактировать элемент';
    if (editIdInput) editIdInput.value = String(item.id);
    if (textInput) {
      textInput.value = item.text;
      textInput.classList.remove('is-invalid');
    }
    const deleteBtn = this.querySelector<HTMLButtonElement>('#party-delete-btn');
    if (deleteBtn) deleteBtn.style.display = '';
    this.validateForm();
    this.open();
  }

  close(): void {
    this.modal.hide();
  }

  private open(): void {
    this.modal.show();
  }

  private isRequiredFilled(): boolean {
    const text = this.querySelector<HTMLInputElement>('#party-item-text')?.value.trim();
    return Boolean(text);
  }

  private validateForm(): void {
    if (!this.saveButton) return;
    const valid = this.isRequiredFilled();
    this.saveButton.disabled = !valid;
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
