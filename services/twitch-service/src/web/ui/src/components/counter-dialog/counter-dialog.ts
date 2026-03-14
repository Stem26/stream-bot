import template from './counter-dialog.html?raw';
import './counter-dialog.scss';
import { substituteTimePlaceholders } from '../../utils/time-placeholders';
import type { Counter } from '../../types';

export interface CounterDialogSaveDetail {
  counter: Counter;
  editId?: string;
}

export class CounterDialogElement extends HTMLElement {
  private initialized = false;
  private escHandler?: (event: KeyboardEvent) => void;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;

    this.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    const form = this.querySelector<HTMLFormElement>('#counter-form');
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
  }

  openForCreate(): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-counter-id');
    const idInput = this.querySelector<HTMLInputElement>('#counter-id');
    const form = this.querySelector<HTMLFormElement>('#counter-form');

    modalTitle && (modalTitle.textContent = 'Добавить счётчик');
    form?.reset();
    if (editIdInput) editIdInput.value = '';
    if (idInput) idInput.disabled = false;

    const valueInput = this.querySelector<HTMLInputElement>('#counter-value');
    if (valueInput) valueInput.value = '0';

    this.updateCounterTemplateCounter();
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
    const modal = this.querySelector<HTMLElement>('.modal');
    modal?.classList.remove('active');
    document.body.classList.remove('modal-open');
  }

  private open(): void {
    const modal = this.querySelector<HTMLElement>('.modal');
    modal?.classList.add('active');
    document.body.classList.add('modal-open');

    if (!this.escHandler) {
      this.escHandler = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          this.close();
        }
      };
      document.addEventListener('keydown', this.escHandler);
    }
  }

  private collectFormData(): CounterDialogSaveDetail | null {
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-counter-id');
    const idInput = this.querySelector<HTMLInputElement>('#counter-id');
    const triggerInput = this.querySelector<HTMLInputElement>('#counter-trigger');
    const aliasesInput = this.querySelector<HTMLInputElement>('#counter-aliases');
    const templateInput = this.querySelector<HTMLTextAreaElement>('#counter-template');
    const valueInput = this.querySelector<HTMLInputElement>('#counter-value');
    const descriptionInput = this.querySelector<HTMLInputElement>('#counter-description');

    if (!idInput || !triggerInput || !templateInput || !valueInput) {
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
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'counter-dialog': CounterDialogElement;
  }
}

customElements.define('counter-dialog', CounterDialogElement);
