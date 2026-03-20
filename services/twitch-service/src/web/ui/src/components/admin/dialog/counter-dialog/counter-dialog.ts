import template from './counter-dialog.html?raw';
import './counter-dialog.scss';
import { createModal } from '../../../../utils/modal';
import { substituteTimePlaceholders } from '../../../../utils/time-placeholders';
import type { Counter } from '../../../../types';

export interface CounterDialogSaveDetail {
  counter: Counter;
  editId?: string;
}

export interface CounterDialogDeleteDetail {
  id: string;
}

export class CounterDialogElement extends HTMLElement {
  private initialized = false;
  private saveButton: HTMLButtonElement | null = null;
  private modal!: ReturnType<typeof createModal>;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.modal = createModal(() => this.querySelector('.modal'));

    this.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    const form = this.querySelector<HTMLFormElement>('#counter-form');
    this.saveButton = this.querySelector<HTMLButtonElement>('.form-actions .btn.btn-success');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const detail = this.collectFormData();
      if (!detail) return;
      this.dispatchEvent(
        new CustomEvent<CounterDialogSaveDetail>('save', {
          detail,
          bubbles: true,
        }),
      );
    });

    const deleteBtn = this.querySelector<HTMLButtonElement>('#counter-delete-btn');
    deleteBtn?.addEventListener('click', () => {
      const editIdInput = this.querySelector<HTMLInputElement>('#edit-counter-id');
      const id = editIdInput?.value || '';
      if (!id) return;
      this.dispatchEvent(
        new CustomEvent<CounterDialogDeleteDetail>('delete', {
          detail: { id },
          bubbles: true,
        }),
      );
    });

    const templateTextarea = this.querySelector<HTMLTextAreaElement>('#counter-template');
    const valueInput = this.querySelector<HTMLInputElement>('#counter-value');
    const counterEl = this.querySelector<HTMLElement>('#counter-template-counter');
    const updateCounter = () => {
      const raw = templateTextarea?.value ?? '';
      const valueStr = valueInput?.value ?? '0';
      const withValue = raw.replace(/\{value\}/g, valueStr);
      const effective = substituteTimePlaceholders(withValue);
      if (counterEl) counterEl.textContent = `${effective.length} / 500`;
    };
    templateTextarea?.addEventListener('input', updateCounter);
    templateTextarea?.addEventListener('change', updateCounter);
    valueInput?.addEventListener('input', updateCounter);

    const requiredFields = [
      this.querySelector<HTMLInputElement>('#counter-id'),
      this.querySelector<HTMLInputElement>('#counter-trigger'),
      this.querySelector<HTMLTextAreaElement>('#counter-template'),
    ].filter(Boolean) as (HTMLInputElement | HTMLTextAreaElement)[];

    requiredFields.forEach((el) => {
      el.addEventListener('blur', () => {
        const empty = !el.value.trim();
        el.classList.toggle('is-invalid', empty);
        this.validateForm();
      });
      el.addEventListener('input', () => {
        if (el.value.trim()) el.classList.remove('is-invalid');
        this.validateForm();
      });
    });

    this.validateForm();
  }

  openForCreate(): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-counter-id');
    const idInput = this.querySelector<HTMLInputElement>('#counter-id');
    const form = this.querySelector<HTMLFormElement>('#counter-form');
    const deleteBtn = this.querySelector<HTMLButtonElement>('#counter-delete-btn');
    const accessLevelSelect = this.querySelector<HTMLSelectElement>('#counter-access-level');

    modalTitle && (modalTitle.textContent = 'Добавить счётчик');
    form?.reset();
    ['#counter-id', '#counter-trigger', '#counter-template'].forEach((sel) => {
      this.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.classList.remove('is-invalid');
    });
    if (editIdInput) editIdInput.value = '';
    if (idInput) idInput.disabled = false;

    const valueInput = this.querySelector<HTMLInputElement>('#counter-value');
    if (valueInput) valueInput.value = '0';

    if (deleteBtn) deleteBtn.style.display = 'none';

    if (accessLevelSelect) {
      accessLevelSelect.value = 'everyone';
    }

    this.updateCounterTemplateCounter();
    this.validateForm();
    this.open();
  }

  openForEdit(counter: Counter): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-counter-id');
    const idInput = this.querySelector<HTMLInputElement>('#counter-id');
    const triggerInput = this.querySelector<HTMLInputElement>('#counter-trigger');
    const aliasesInput = this.querySelector<HTMLInputElement>('#counter-aliases');
    const templateInput = this.querySelector<HTMLTextAreaElement>('#counter-template');
    const valueInput = this.querySelector<HTMLInputElement>('#counter-value');
    const descriptionInput = this.querySelector<HTMLInputElement>('#counter-description');
    const accessLevelSelect = this.querySelector<HTMLSelectElement>('#counter-access-level');
    const deleteBtn = this.querySelector<HTMLButtonElement>('#counter-delete-btn');

    if (modalTitle) modalTitle.textContent = 'Редактировать счётчик';
    if (editIdInput) editIdInput.value = counter.id;
    if (idInput) {
      idInput.value = counter.id;
      idInput.disabled = true;
    }
    if (triggerInput) triggerInput.value = counter.trigger;
    if (aliasesInput) aliasesInput.value = counter.aliases.join(', ');
    if (templateInput) templateInput.value = counter.responseTemplate;
    if (valueInput) valueInput.value = String(counter.value ?? 0);
    if (descriptionInput) descriptionInput.value = counter.description ?? '';
    if (accessLevelSelect) accessLevelSelect.value = counter.accessLevel ?? 'everyone';

    ['#counter-id', '#counter-trigger', '#counter-template'].forEach((sel) => {
      this.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.classList.remove('is-invalid');
    });

    if (deleteBtn) deleteBtn.style.display = 'inline-flex';

    this.validateForm();

    this.updateCounterTemplateCounter();
    this.open();
  }

  private updateCounterTemplateCounter(): void {
    const ta = this.querySelector<HTMLTextAreaElement>('#counter-template');
    const valueInput = this.querySelector<HTMLInputElement>('#counter-value');
    const counter = this.querySelector<HTMLElement>('#counter-template-counter');
    const raw = ta?.value ?? '';
    const valueStr = valueInput?.value ?? '0';
    const withValue = raw.replace(/\{value\}/g, valueStr);
    const effective = substituteTimePlaceholders(withValue);
    if (counter) counter.textContent = `${effective.length} / 500`;
  }

  close(): void {
    this.modal.hide();
  }

  private open(): void {
    this.modal.show();
  }

  private isRequiredFilled(): boolean {
    const id = this.querySelector<HTMLInputElement>('#counter-id')?.value.trim();
    const trigger = this.querySelector<HTMLInputElement>('#counter-trigger')?.value.trim();
    const template = this.querySelector<HTMLTextAreaElement>('#counter-template')?.value.trim();
    return Boolean(id && trigger && template);
  }

  private validateForm(): void {
    if (!this.saveButton) return;
    const valid = this.isRequiredFilled();
    this.saveButton.disabled = !valid;
  }

  private collectFormData(): CounterDialogSaveDetail | null {
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-counter-id');
    const idInput = this.querySelector<HTMLInputElement>('#counter-id');
    const triggerInput = this.querySelector<HTMLInputElement>('#counter-trigger');
    const aliasesInput = this.querySelector<HTMLInputElement>('#counter-aliases');
    const templateInput = this.querySelector<HTMLTextAreaElement>('#counter-template');
    const valueInput = this.querySelector<HTMLInputElement>('#counter-value');
    const descriptionInput = this.querySelector<HTMLInputElement>('#counter-description');
    const accessLevelSelect = this.querySelector<HTMLSelectElement>('#counter-access-level');

    if (!idInput || !triggerInput || !templateInput || !valueInput || !accessLevelSelect) {
      return null;
    }

    const id = idInput.value.trim();
    const trigger = triggerInput.value.trim();
    const responseTemplate = templateInput.value.trim();

    if (!id || !trigger || !responseTemplate) {
      return null;
    }

    const aliases =
      aliasesInput?.value
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a) ?? [];

    const parsedValue = parseInt(valueInput.value, 10);
    const value = Number.isNaN(parsedValue) ? 0 : parsedValue;

    const counter: Counter = {
      id,
      trigger,
      aliases,
      responseTemplate,
      value,
      enabled: true,
      description: descriptionInput?.value.trim() ?? '',
      accessLevel: accessLevelSelect.value as Counter['accessLevel'],
    };

    return {
      counter,
      editId: editIdInput?.value || undefined,
    };
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
    'counter-dialog': CounterDialogElement;
  }
}

customElements.define('counter-dialog', CounterDialogElement);
