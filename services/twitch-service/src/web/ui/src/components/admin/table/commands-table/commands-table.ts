// @ts-ignore
import template from './commands-table.html?raw';
import './commands-table.scss';
import { showAlert } from '../../../../alerts';
import {
  authFetch,
  createCommand,
  deleteCommand,
  fetchCommands,
  toggleCommand,
  toggleCommandRotation,
  updateCommand,
} from '../../../../api';
import type { CommandsData, CustomCommand } from '../../../../types';
import type { CommandDialogElement, CommandDialogSaveDetail } from '../../dialog/command-dialog/command-dialog';
import { getAdminPassword } from '../../../../admin-auth';

export class CommandsTableElement extends HTMLElement {
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.setupHandlers();
    if (getAdminPassword()) void this.loadCommands();
    window.addEventListener('admin-auth-success', this.handleAuthSuccess);
  }

  disconnectedCallback(): void {
    window.removeEventListener('admin-auth-success', this.handleAuthSuccess);
  }

  private handleAuthSuccess = (): void => {
    void this.loadCommands();
  };

  private getTemplate(id: string): HTMLTemplateElement | null {
    return this.querySelector<HTMLTemplateElement>(`#${id}`);
  }

  private renderCommands(data: CommandsData): void {
    const container = this.querySelector<HTMLElement>('#commands-container');
    const emptyState = this.querySelector<HTMLElement>('#empty-state');
    const table = this.querySelector<HTMLTableElement>('#commands-table');
    const tbody = this.querySelector<HTMLElement>('#commands-tbody');
    const rowTpl = this.getTemplate('template-command-row');
    const loadingEl = container?.querySelector<HTMLElement>('.loading');

    if (!container || !emptyState || !table || !tbody || !rowTpl) return;

    container.classList.remove('loading-state');
    if (loadingEl) loadingEl.style.display = 'none';
    tbody.innerHTML = '';

    if (data.commands.length === 0) {
      table.style.display = 'none';
      if (loadingEl) loadingEl.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';
    table.style.display = 'table';

    data.commands.forEach((cmd, index) => {
      const tr = (rowTpl.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLTableRowElement;
      tr.dataset.id = encodeURIComponent(cmd.id);
      tr.dataset.messageType = cmd.messageType;
      tr.dataset.color = cmd.color ?? '';
      tr.classList.toggle('disabled', !cmd.enabled);

      const numCell = tr.querySelector('.col-num');
      const triggerCell = tr.querySelector('.col-trigger');
      const accessCell = tr.querySelector('.col-access .access-text');
      const responseCell = tr.querySelector('.col-response');
      const statusBtn = tr.querySelector<HTMLButtonElement>('.col-status [data-action="toggle"]');
      const rotationBtn = tr.querySelector<HTMLButtonElement>('.col-rotation [data-action="toggle-rotation"]');
      const sendBtn = tr.querySelector<HTMLButtonElement>('.col-actions [data-action="send"]');

      if (numCell) numCell.textContent = String(index + 1);
      const triggerText = triggerCell?.querySelector('.trigger-text');
      if (triggerText) {
        triggerText.textContent = cmd.trigger;
        triggerCell!.setAttribute('title', cmd.trigger);
      }
      if (accessCell) {
        accessCell.textContent = cmd.accessLevel === 'moderators' ? 'Модераторам' : 'Всем';
      }
      if (responseCell) {
        responseCell.textContent = cmd.response;
        responseCell.setAttribute('title', cmd.response);
      }
      if (statusBtn) {
        statusBtn.textContent = cmd.enabled ? 'ВКЛ' : 'ВЫКЛ';
        statusBtn.className = `status-badge ${cmd.enabled ? 'on' : 'off'}`;
        statusBtn.title = cmd.enabled ? 'Выключить' : 'Включить';
      }
      if (rotationBtn) {
        rotationBtn.textContent = cmd.inRotation ? 'ДА' : 'НЕТ';
        rotationBtn.className = `status-badge rotation-badge ${cmd.inRotation ? 'on' : 'off'}`;
        rotationBtn.title = cmd.inRotation ? 'Убрать из ротации' : 'Добавить в ротацию';
      }
      if (sendBtn) sendBtn.disabled = !cmd.enabled;
      tbody.appendChild(tr);
    });
  }

  async loadCommands(): Promise<void> {
    try {
      const data = await fetchCommands();
      this.renderCommands(data);
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки команд: ${error.message}`, 'error');
      }
    }
  }

  private setupHandlers(): void {
    const commandsContainer = this.querySelector('#commands-container');
    const addBtn = this.querySelector('#add-command-btn');
    const commandDialog = document.querySelector<CommandDialogElement>('command-dialog');

    if (!commandDialog) return;

    addBtn?.addEventListener('click', () => {
      commandDialog.openForCreate();
    });

    commandDialog.addEventListener('save', async (event: Event) => {
      const customEvent = event as CustomEvent<CommandDialogSaveDetail>;
      const { command, editId } = customEvent.detail;
      try {
        if (editId) {
          await updateCommand(editId, command as CustomCommand);
        } else {
          await createCommand(command as CustomCommand);
        }
        commandDialog.close();
        await this.loadCommands();
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }
    });

    commandDialog.addEventListener('delete', async (event: Event) => {
      const customEvent = event as CustomEvent<{ editId: string }>;
      const editId = customEvent.detail?.editId;
      if (!editId) return;
      try {
        await deleteCommand(editId);
        commandDialog.close();
        await this.loadCommands();
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }
    });

    commandsContainer?.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const row = target.closest<HTMLElement>('.command-table-row');
      if (!row) return;
      const encodedId = row.getAttribute('data-id');
      if (!encodedId) return;
      const id = decodeURIComponent(encodedId);
      const actionEl = target.closest<HTMLElement>('[data-action]');
      const action = actionEl?.getAttribute('data-action');

      if (action === 'toggle') {
        try {
          await toggleCommand(id);
          await this.loadCommands();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
        return;
      }

      if (action === 'toggle-rotation') {
        try {
          await toggleCommandRotation(id);
          await this.loadCommands();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
        return;
      }

      if (action === 'send') {
        if (row.classList.contains('disabled')) {
          showAlert('Команда выключена. Включи её, чтобы отправить в чат.', 'error');
          return;
        }
        try {
          const res = await authFetch(`/api/commands/${encodeURIComponent(id)}/send`, { method: 'POST' });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
          }
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка отправки команды: ${error.message}`, 'error');
        }
        return;
      }

      const triggerTextEl = row.querySelector('.trigger-text');
      if (triggerTextEl && triggerTextEl.contains(target)) {
        const text = triggerTextEl.textContent?.trim() ?? '';
        if (text) {
          try {
            await navigator.clipboard.writeText(text);
            showAlert('Триггер скопирован');
          } catch {
            showAlert('Не удалось скопировать', 'error');
          }
        }
        return;
      }

      if (!actionEl) {
        try {
          const data = await fetchCommands();
          const command = data.commands.find((cmd) => cmd.id === id);
          if (!command) {
            showAlert('Команда не найдена', 'error');
            return;
          }
          commandDialog.openForEdit(command);
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка загрузки команды: ${error.message}`, 'error');
        }
      }
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'commands-table': CommandsTableElement;
  }
}

customElements.define('commands-table', CommandsTableElement);
