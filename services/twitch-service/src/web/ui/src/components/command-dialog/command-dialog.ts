import template from './command-dialog.html?raw';
import './command-dialog.scss';
import type { CustomCommand, MessageType, CommandColor } from '../../types';

export interface CommandDialogSaveDetail {
  command: CustomCommand;
  editId?: string;
}

export class CommandDialogElement extends HTMLElement {
  private initialized = false;
  private saveButton: HTMLButtonElement | null = null;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;

    this.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.close());
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
      this.validateCooldown();
    });

    cooldownInput?.addEventListener('input', () => this.validateCooldown());

    // начальная валидация
    this.validateCooldown();
  }

  openForCreate(): void {
    this.ensureInit();
    const modalTitle = this.querySelector<HTMLElement>('#modal-title');
    const editIdInput = this.querySelector<HTMLInputElement>('#edit-command-id');
    const idInput = this.querySelector<HTMLInputElement>('#command-id');
    const form = this.querySelector<HTMLFormElement>('#command-form');

    modalTitle && (modalTitle.textContent = 'Добавить команду');
    form?.reset();
    if (editIdInput) editIdInput.value = '';
    if (idInput) idInput.disabled = false;

    const cooldown = this.querySelector<HTMLInputElement>('#command-cooldown');
    if (cooldown) cooldown.value = '10';
    this.validateCooldown();
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

    this.toggleColorField();
    this.validateCooldown();
    this.open();
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
  }

  private toggleColorField(): void {
    const messageTypeSelect = this.querySelector<HTMLSelectElement>('#command-message-type');
    const colorField = this.querySelector<HTMLElement>('#color-field');
    if (!messageTypeSelect || !colorField) return;

    colorField.style.display = messageTypeSelect.value === 'announcement' ? 'block' : 'none';
  }

  private validateCooldown(): boolean {
    const messageTypeSelect = this.querySelector<HTMLSelectElement>('#command-message-type');
    const cooldownInput = this.querySelector<HTMLInputElement>('#command-cooldown');
    const errorEl = this.querySelector<HTMLElement>('#command-cooldown-error');

    if (!messageTypeSelect || !cooldownInput) {
      return true;
    }

    const value = parseInt(cooldownInput.value, 10);
    const isAnnouncement = messageTypeSelect.value === 'announcement';

    let isValid = true;

    if (isAnnouncement && (isNaN(value) || value < 5)) {
      isValid = false;
    }

    if (!isValid) {
      cooldownInput.classList.add('is-invalid');
      if (errorEl) errorEl.style.display = 'block';
      if (this.saveButton) this.saveButton.disabled = true;
    } else {
      cooldownInput.classList.remove('is-invalid');
      if (errorEl) errorEl.style.display = 'none';
      if (this.saveButton) this.saveButton.disabled = false;
    }

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

    // если валидация кулдауна не проходит — не даём сохранить
    if (!this.validateCooldown()) {
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
      messageType: messageTypeSelect.value as MessageType,
      color: colorSelect.value as CommandColor,
      cooldown: parseInt(cooldownInput.value, 10) || 10,
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
}

declare global {
  interface HTMLElementTagNameMap {
    'command-dialog': CommandDialogElement;
  }
}

customElements.define('command-dialog', CommandDialogElement);

