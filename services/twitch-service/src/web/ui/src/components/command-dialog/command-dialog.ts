// @ts-ignore
import template from './command-dialog.html?raw';
import './command-dialog.scss';
import { createModal } from '../../utils/modal';
import { substituteTimePlaceholders } from '../../utils/time-placeholders';
import type { CustomCommand, MessageType, CommandColor } from '../../types';

const ANNOUNCEMENT_COLORS: {value: CommandColor; label: string }[] =[
  {value: "primary", label: 'Обычный (Primary)'},
  {value: "blue", label: 'Синий (Blue)'},
  {value: "green", label: 'Зелёный (Green)'},
  {value: "orange", label: 'Оранжевый (Orange)'},
  {value: "purple", label: 'Фиолетовый (Purple)'},
]

export interface CommandDialogSaveDetail {
  command: CustomCommand;
  editId?: string;
}

export class CommandDialogElement extends HTMLElement {
  private initialized = false;
  private saveButton: HTMLButtonElement | null = null;
  private modal!: ReturnType<typeof createModal>;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.modal = createModal(() => this.querySelector('.modal'));

    const colorSelect = this.querySelector<HTMLInputElement>('#command-color')
    if (colorSelect) {
      colorSelect.innerHTML = ANNOUNCEMENT_COLORS.map((color) =>
          `<option value="${color.value}">${color.label}</option>`).join('')
    }

    this.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
    });

    const deleteBtn = this.querySelector<HTMLButtonElement>('#command-delete-btn');
    deleteBtn?.addEventListener('click', () => {
      const editIdInput = this.querySelector<HTMLInputElement>('#edit-command-id');
      const editId = editIdInput?.value?.trim();
      if (!editId) return;
      if (!confirm('Удалить команду?')) return;
      this.dispatchEvent(new CustomEvent('delete', { detail: { editId }, bubbles: true }));
    });

    const form = this.querySelector<HTMLFormElement>('#command-form');
    const cooldownInput = this.querySelector<HTMLInputElement>('#command-cooldown');
    const messageTypeSelect = this.querySelector<HTMLSelectElement>('#command-message-type');
    this.saveButton = this.querySelector<HTMLButtonElement>('.form-actions .btn.btn-success');

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const detail = this.collectFormData();
      if (!detail) return;
      this.dispatchEvent(
        new CustomEvent<CommandDialogSaveDetail>('save', {
          detail,
          bubbles: true,
        }),
      );
    });

    messageTypeSelect?.addEventListener('change', () => {
      this.toggleColorField();
      this.validateForm();
    });

    cooldownInput?.addEventListener('input', () => this.validateForm());

    const requiredFields = [
      this.querySelector<HTMLInputElement>('#command-id'),
      this.querySelector<HTMLInputElement>('#command-trigger'),
      this.querySelector<HTMLTextAreaElement>('#command-response'),
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

    const responseTextarea = this.querySelector<HTMLTextAreaElement>('#command-response');
    const counterEl = this.querySelector<HTMLElement>('#command-response-counter');
    const updateCounter = () => {
      const raw = responseTextarea?.value ?? '';
      const effective = substituteTimePlaceholders(raw);
      if (counterEl) {
        counterEl.textContent = `${effective.length} / 500`;
      }
    };

    responseTextarea?.addEventListener('input', updateCounter);
    responseTextarea?.addEventListener('change', updateCounter);

    this.validateForm();
  }

  openForCreate(): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-command-id');
    const idInput = this.querySelector<HTMLInputElement>('#command-id');
    const form = this.querySelector<HTMLFormElement>('#command-form');
    const messageTypeSelect = this.querySelector<HTMLSelectElement>('#command-message-type');
    const colorSelect = this.querySelector<HTMLSelectElement>('#command-color');

    modalTitle && (modalTitle.textContent = 'Добавить команду');
    form?.reset();
    ['#command-id', '#command-trigger', '#command-response'].forEach((sel) => {
      this.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.classList.remove('is-invalid');
    });
    if (editIdInput) {
      editIdInput.value = '';
    }

    if (idInput) {
      idInput.disabled = false;
    }

    if (messageTypeSelect) {
      messageTypeSelect.value = 'message';
    }

    if (colorSelect) {
      colorSelect.value = 'primary';
    }

    const cooldown = this.querySelector<HTMLInputElement>('#command-cooldown');
    if (cooldown) {
      cooldown.value = '0';
    }

    const deleteBtn = this.querySelector<HTMLButtonElement>('#command-delete-btn');
    if (deleteBtn) deleteBtn.style.display = 'none';

    this.toggleColorField();
    this.validateForm();
    this.updateResponseCounter();
    this.open();
  }

  openForEdit(command: CustomCommand): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-command-id');
    const idInput = this.querySelector<HTMLInputElement>('#command-id');
    const triggerInput = this.querySelector<HTMLInputElement>('#command-trigger');
    const aliasesInput = this.querySelector<HTMLInputElement>('#command-aliases');
    const responseInput = this.querySelector<HTMLTextAreaElement>('#command-response');
    const descriptionInput = this.querySelector<HTMLInputElement>('#command-description');
    const messageTypeSelect = this.querySelector<HTMLSelectElement>('#command-message-type');
    const colorSelect = this.querySelector<HTMLSelectElement>('#command-color');
    const cooldownInput = this.querySelector<HTMLInputElement>('#command-cooldown');

    if (modalTitle) modalTitle.textContent = 'Редактировать команду';
    if (editIdInput) editIdInput.value = command.id;
    if (idInput) {
      idInput.value = command.id;
      idInput.disabled = true;
    }
    if (triggerInput) triggerInput.value = command.trigger;
    if (aliasesInput) aliasesInput.value = command.aliases.join(', ');
    if (responseInput) responseInput.value = command.response;
    if (descriptionInput) descriptionInput.value = command.description ?? '';
    if (messageTypeSelect) messageTypeSelect.value = command.messageType ?? 'announcement';
    if (colorSelect) colorSelect.value = command.color ?? 'primary';
    if (cooldownInput) cooldownInput.value = String(command.cooldown ?? 10);
    ['#command-id', '#command-trigger', '#command-response'].forEach((sel) => {
      this.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.classList.remove('is-invalid');
    });

    const deleteBtn = this.querySelector<HTMLButtonElement>('#command-delete-btn');
    if (deleteBtn) deleteBtn.style.display = '';

    this.toggleColorField();
    this.validateForm();
    this.updateResponseCounter();
    this.open();
  }

  private updateResponseCounter(): void {
    const ta = this.querySelector<HTMLTextAreaElement>('#command-response');
    const counter = this.querySelector<HTMLElement>('#command-response-counter');
    const raw = ta?.value ?? '';
    const effective = substituteTimePlaceholders(raw);
    if (counter) counter.textContent = `${effective.length} / 500`;
  }

  close(): void {
    this.modal.hide();
  }

  private open(): void {
    this.modal.show();
  }

  private toggleColorField(): void {
    const messageTypeSelect = this.querySelector<HTMLSelectElement>('#command-message-type');
    const colorField = this.querySelector<HTMLElement>('#color-field');
    if (!messageTypeSelect || !colorField) return;

    colorField.style.display = messageTypeSelect.value === 'announcement' ? 'block' : 'none';
  }

  private isRequiredFilled(): boolean {
    const id = this.querySelector<HTMLInputElement>('#command-id')?.value.trim();
    const trigger = this.querySelector<HTMLInputElement>('#command-trigger')?.value.trim();
    const response = this.querySelector<HTMLTextAreaElement>('#command-response')?.value.trim();
    return Boolean(id && trigger && response);
  }

  private validateForm(): void {
    const requiredOk = this.isRequiredFilled();
    const cooldownOk = this.validateCooldown();
    if (this.saveButton) this.saveButton.disabled = !requiredOk || !cooldownOk;
  }

  private validateCooldown(): boolean {
    const messageTypeSelect = this.querySelector<HTMLSelectElement>('#command-message-type');
    const cooldownInput = this.querySelector<HTMLInputElement>('#command-cooldown');
    const errorEl = this.querySelector<HTMLElement>('#command-cooldown-error');

    if (!messageTypeSelect || !cooldownInput) return true;

    const value = parseInt(cooldownInput.value, 10);
    const isAnnouncement = messageTypeSelect.value === 'announcement';
    const isValid = !isAnnouncement || (!isNaN(value) && value >= 5);

    cooldownInput.classList.toggle('is-invalid', !isValid);
    if (errorEl) errorEl.style.display = isValid ? 'none' : 'block';
    return isValid;
  }

  private collectFormData(): CommandDialogSaveDetail | null {
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-command-id');
    const idInput = this.querySelector<HTMLInputElement>('#command-id');
    const triggerInput = this.querySelector<HTMLInputElement>('#command-trigger');
    const aliasesInput = this.querySelector<HTMLInputElement>('#command-aliases');
    const responseInput = this.querySelector<HTMLTextAreaElement>('#command-response');
    const descriptionInput = this.querySelector<HTMLInputElement>('#command-description');
    const messageTypeSelect = this.querySelector<HTMLSelectElement>('#command-message-type');
    const colorSelect = this.querySelector<HTMLSelectElement>('#command-color');
    const cooldownInput = this.querySelector<HTMLInputElement>('#command-cooldown');

    if (!idInput || !triggerInput || !responseInput || !messageTypeSelect || !colorSelect || !cooldownInput) {
      return null;
    }

    const messageType = messageTypeSelect.value as MessageType;
    const parsedCooldown = parseInt(cooldownInput.value, 10);
    const cooldown = Number.isNaN(parsedCooldown) ? 0 : parsedCooldown;

    if (messageType === 'announcement' && cooldown < 5) {
      this.validateCooldown();
      return null;
    }

    const id = idInput.value.trim();
    const trigger = triggerInput.value.trim();
    const response = responseInput.value.trim();

    if (!id || !trigger || !response) {
      return null;
    }

    const aliases =
      aliasesInput?.value
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a) ?? [];

    const command: CustomCommand = {
      id,
      trigger,
      aliases,
      response,
      description: descriptionInput?.value.trim() ?? '',
      messageType,
      color: colorSelect.value as CommandColor,
      cooldown,
      enabled: true,
    };

    return {
      command,
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
    'command-dialog': CommandDialogElement;
  }
}

customElements.define('command-dialog', CommandDialogElement);

