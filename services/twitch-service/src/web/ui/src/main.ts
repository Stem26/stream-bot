import './styles.scss';
import { showAlert } from './alerts';
import {
  createCommand,
  deleteCommand,
  fetchCommands,
  fetchLinksConfig,
  updateLinksConfig,
  toggleCommand,
  updateCommand,
} from './api';
import type { CommandsData, CustomCommand } from './types';
import './components/command-dialog/command-dialog';
import type { CommandDialogElement, CommandDialogSaveDetail } from './components/command-dialog/command-dialog';
import './components/link-dialog/link-dialog';
import type { LinkDialogElement, LinkDialogSaveDetail } from './components/link-dialog/link-dialog';

function renderCommands(data: CommandsData): void {
  const container = document.getElementById('commands-container');
  const emptyState = document.getElementById('empty-state');
  if (!container || !emptyState) return;

  if (data.commands.length === 0) {
    container.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  container.style.display = 'grid';
  emptyState.style.display = 'none';

  container.innerHTML = data.commands
    .map(
      (cmd) => `
      <div class="command-card ${cmd.enabled ? '' : 'disabled'}" data-id="${cmd.id}">
        <div class="command-header">
          <div class="command-trigger">${cmd.trigger}</div>
          <div class="command-status">
            ${
              cmd.messageType === 'announcement'
                ? `<span class="color-badge ${cmd.color}">${cmd.color}</span>`
                : '<span class="color-badge" style="background: #6c757d;">сообщение</span>'
            }
            <span class="status-badge ${cmd.enabled ? 'enabled' : 'disabled'}">
              ${cmd.enabled ? 'Вкл' : 'Выкл'}
            </span>
          </div>
        </div>

        ${cmd.description ? `<div class="command-description">${cmd.description}</div>` : ''}

        <div class="command-response">${cmd.response}</div>

        ${
          cmd.aliases && cmd.aliases.length > 0
            ? `
          <div class="command-aliases">
            ${cmd.aliases.map((alias) => `<span class="alias-tag">${alias}</span>`).join('')}
          </div>
        `
            : ''
        }

        <div class="command-actions">
          <button class="btn btn-small btn-secondary" data-action="toggle">
            ${cmd.enabled ? '⏸ Выкл' : '▶ Вкл'}
          </button>
          <button class="btn btn-small" data-action="edit">✏️ Изменить</button>
          <button class="btn btn-small btn-danger" data-action="delete">🗑️ Удалить</button>
        </div>
      </div>
    `,
    )
    .join('');
}

async function loadCommands(): Promise<void> {
  try {
    const data = await fetchCommands();
    renderCommands(data);
  } catch (error) {
    if (error instanceof Error) {
      showAlert(`Ошибка загрузки команд: ${error.message}`, 'error');
    }
  }
}

async function initLinks(linkDialog: LinkDialogElement): Promise<void> {
  try {
    const config = await fetchLinksConfig();
    linkDialog.open(config.allLinksText ?? '');
    linkDialog.close();
  } catch (error) {
    if (error instanceof Error) {
      showAlert(`Ошибка загрузки ссылок: ${error.message}`, 'error');
    }
  }
}

async function bootstrap(): Promise<void> {
  const addCommandBtn = document.getElementById('add-command-btn');
  const allLinksBtn = document.getElementById('all-links-btn');
  const commandsContainer = document.getElementById('commands-container');

  const commandDialog = document.querySelector<CommandDialogElement>('command-dialog');
  const linkDialog = document.querySelector<LinkDialogElement>('link-dialog');

  if (!addCommandBtn || !allLinksBtn || !commandsContainer || !commandDialog || !linkDialog) {
    return;
  }

  await initLinks(linkDialog);
  await loadCommands();

  addCommandBtn.addEventListener('click', () => {
    commandDialog.openForCreate();
  });

  allLinksBtn.addEventListener('click', async () => {
    try {
      const config = await fetchLinksConfig();
      linkDialog.open(config.allLinksText ?? '');
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки ссылок: ${error.message}`, 'error');
      }
    }
  });

  commandsContainer.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const card = target.closest<HTMLElement>('.command-card');
    if (!card) return;

    const id = card.dataset.id;
    if (!id) return;

    // Копирование текста по клику на триггер / алиасы / ответ
    const copySource = target.closest<HTMLElement>(
      '.command-trigger, .command-response, .alias-tag',
    );
    if (copySource) {
      const textToCopy = copySource.textContent?.trim();
      if (textToCopy) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(textToCopy);
          }
          showAlert('Текст скопирован в буфер обмена');
        } catch (error) {
          // тихо игнорируем, если что-то пошло не так
          console.error('Clipboard copy failed', error);
        }
      }
      return; // не открываем карточку на редактирование
    }

    const action = target.dataset.action;

    if (!action) {
      // клик по карточке открывает редактирование
      try {
        const data = await fetchCommands();
        const command = data.commands.find((cmd) => cmd.id === id);
        if (!command) {
          showAlert('Команда не найдена', 'error');
          return;
        }
        commandDialog.openForEdit(command);
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка загрузки команды: ${error.message}`, 'error');
        }
      }
      return;
    }

    if (action === 'toggle') {
      try {
        await toggleCommand(id);
        await loadCommands();
        showAlert('Статус команды изменён');
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }
    }

    if (action === 'delete') {
      if (!confirm('Удалить команду?')) return;
      try {
        await deleteCommand(id);
        await loadCommands();
        showAlert('Команда удалена');
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }
    }

    if (action === 'edit') {
      try {
        const data = await fetchCommands();
        const command = data.commands.find((cmd) => cmd.id === id);
        if (!command) {
          showAlert('Команда не найдена', 'error');
          return;
        }
        commandDialog.openForEdit(command);
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка загрузки команды: ${error.message}`, 'error');
        }
      }
    }
  });

  commandDialog.addEventListener('save', async (event: Event) => {
    const customEvent = event as CustomEvent<CommandDialogSaveDetail>;
    const { command, editId } = customEvent.detail;

    try {
      if (editId) {
        await updateCommand(editId, command as CustomCommand);
        showAlert('Команда обновлена');
      } else {
        await createCommand(command as CustomCommand);
        showAlert('Команда создана');
      }
      commandDialog.close();
      await loadCommands();
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка: ${error.message}`, 'error');
      }
    }
  });

  linkDialog.addEventListener('save', async (event: Event) => {
    const customEvent = event as CustomEvent<LinkDialogSaveDetail>;
    const { allLinksText } = customEvent.detail;
    try {
      await updateLinksConfig(allLinksText);
      showAlert('Ссылки сохранены');
      linkDialog.close();
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка сохранения ссылок: ${error.message}`, 'error');
      }
    }
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
});

