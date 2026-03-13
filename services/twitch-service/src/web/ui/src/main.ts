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
  fetchCounters,
  createCounter,
  updateCounter,
  deleteCounter,
  toggleCounter,
} from './api';
import type { CommandsData, CustomCommand, CountersData, Counter } from './types';
import './components/command-dialog/command-dialog';
import type { CommandDialogElement, CommandDialogSaveDetail } from './components/command-dialog/command-dialog';
import './components/link-dialog/link-dialog';
import type { LinkDialogElement, LinkDialogSaveDetail } from './components/link-dialog/link-dialog';
import './components/counter-dialog/counter-dialog';
import type { CounterDialogElement, CounterDialogSaveDetail } from './components/counter-dialog/counter-dialog';

function setupTabs(): void {
  const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
  const tabContents = document.querySelectorAll<HTMLElement>('.tab-content');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      if (!targetTab) return;

      // Убираем active у всех кнопок и контента
      tabButtons.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => c.classList.remove('active'));

      // Добавляем active к выбранным
      btn.classList.add('active');
      const targetContent = document.getElementById(`tab-${targetTab}`);
      if (targetContent) {
        targetContent.classList.add('active');
      }
    });
  });
}

async function checkAuth(): Promise<boolean> {
  try {
    // Пробуем загрузить защищенный endpoint
    const response = await fetch('/api/commands');
    return response.ok;
  } catch (error) {
    return false;
  }
}

function showAdminContent(): void {
  document.querySelectorAll<HTMLElement>('.admin-only').forEach((el) => {
    el.style.display = '';
  });
}

function hideAdminContent(): void {
  document.querySelectorAll<HTMLElement>('.admin-only').forEach((el) => {
    el.style.display = 'none';
  });
  
  // Переключаемся на публичную вкладку
  const leaderboardTab = document.querySelector<HTMLButtonElement>('[data-tab="leaderboard"]');
  leaderboardTab?.click();
}

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
      (cmd) => {
        const encodedId = encodeURIComponent(cmd.id);
        return `
      <div
        class="command-card ${cmd.enabled ? '' : 'disabled'}"
        data-id="${encodedId}"
        data-message-type="${cmd.messageType}"
        data-color="${cmd.color}"
      >
        <div class="command-header">
          <div class="command-trigger">${cmd.trigger}</div>
          <div class="command-status">
            ${
              cmd.messageType === 'announcement'
                ? `<span class="color-badge ${cmd.color}">${cmd.color}</span>`
                : '<span class="color-badge" style="background: #6c757d;">сообщение</span>'
            }
            <div class="status-toggle ${cmd.enabled ? 'on' : 'off'}" data-action="toggle">
              <div class="status-toggle-circle"></div>
              <span class="status-toggle-text">${cmd.enabled ? 'ВКЛ' : 'ВЫКЛ'}</span>
            </div>
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
          <button class="btn btn-small" data-action="send" ${cmd.enabled ? '' : 'disabled'}>🚀 В чат</button>
          <button class="btn btn-small" data-action="edit">✏️ Изменить</button>
          <button class="btn btn-small btn-danger" data-action="delete">🗑️ Удалить</button>
        </div>
      </div>
    `;
      },
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

function renderCounters(data: CountersData): void {
  const container = document.getElementById('counters-container');
  const emptyState = document.getElementById('empty-counters-state');
  if (!container || !emptyState) return;

  if (data.counters.length === 0) {
    container.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  container.style.display = 'grid';
  emptyState.style.display = 'none';

  container.innerHTML = data.counters
    .map(
      (counter) => {
        const encodedId = encodeURIComponent(counter.id);
        return `
      <div
        class="command-card counter-card ${counter.enabled ? '' : 'disabled'}"
        data-id="${encodedId}"
      >
        <div class="command-header">
          <div class="command-trigger">${counter.trigger}</div>
          <div class="command-status">
            <div class="status-toggle ${counter.enabled ? 'on' : 'off'}" data-action="toggle">
              <div class="status-toggle-circle"></div>
              <span class="status-toggle-text">${counter.enabled ? 'ВКЛ' : 'ВЫКЛ'}</span>
            </div>
          </div>
        </div>

        ${counter.description ? `<div class="command-description">${counter.description}</div>` : ''}

        <div class="counter-value-display">
          <div class="counter-label">Текущее значение:</div>
          <div class="counter-value">${counter.value}</div>
        </div>

        <div class="counter-template">
          <strong>Шаблон ответа:</strong> ${counter.responseTemplate}
        </div>

        ${
          counter.aliases && counter.aliases.length > 0
            ? `
          <div class="command-aliases">
            ${counter.aliases.map((alias) => `<span class="alias-tag">${alias}</span>`).join('')}
          </div>
        `
            : ''
        }

        <div class="command-actions">
          <button class="btn btn-small" data-action="edit-value">✏️ Изменить значение</button>
          <button class="btn btn-small" data-action="edit">⚙️ Настройки</button>
          <button class="btn btn-small btn-danger" data-action="delete">🗑️ Удалить</button>
        </div>
      </div>
    `;
      },
    )
    .join('');
}

async function loadCounters(): Promise<void> {
  try {
    const data = await fetchCounters();
    renderCounters(data);
  } catch (error) {
    if (error instanceof Error) {
      showAlert(`Ошибка загрузки счётчиков: ${error.message}`, 'error');
    }
  }
}

async function loadDuelsStatus(): Promise<void> {
  try {
    const response = await fetch('/api/admin/duels/status');
    const data = await response.json();
    const statusEl = document.getElementById('duels-status');
    if (statusEl) {
      statusEl.textContent = data.enabled ? '✅ Включены' : '❌ Выключены';
      statusEl.style.color = data.enabled ? '#28a745' : '#dc3545';
    }
  } catch (error) {
    console.error('Ошибка загрузки статуса дуэлей:', error);
  }
}

let currentLeaderboardPage = 1;
const leaderboardPageSize = 50;

async function loadLeaderboard(page: number = 1): Promise<void> {
  try {
    currentLeaderboardPage = page;
    const response = await fetch(`/api/leaderboard?page=${page}&limit=${leaderboardPageSize}`);
    const data = await response.json();
    const container = document.getElementById('leaderboard-table');
    
    if (!container) return;

    if (!data.players || data.players.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: #6c757d;">Пока нет данных</p>';
      return;
    }

    const { pagination } = data;
    const startRank = (pagination.page - 1) * pagination.limit;

    const tableHTML = `
      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Игрок</th>
            <th>Очки</th>
            <th>Статистика</th>
          </tr>
        </thead>
        <tbody>
          ${data.players
            .map(
              (p: any, index: number) => `
            <tr>
              <td class="rank">${startRank + index + 1}</td>
              <td class="username">${p.twitch_username}</td>
              <td class="points">${p.points}</td>
              <td class="stats">
                Побед: ${p.duel_wins || 0} | Проигрышей: ${p.duel_losses || 0} | Ничьих: ${p.duel_draws || 0}
              </td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
      <div class="pagination">
        <button 
          class="btn btn-small" 
          id="prev-page-btn" 
          ${pagination.page <= 1 ? 'disabled' : ''}
        >← Назад</button>
        <span class="pagination-info">
          Страница ${pagination.page} из ${pagination.totalPages} (всего: ${pagination.total})
        </span>
        <button 
          class="btn btn-small" 
          id="next-page-btn"
          ${pagination.page >= pagination.totalPages ? 'disabled' : ''}
        >Вперёд →</button>
      </div>
    `;

    container.innerHTML = tableHTML;

    // Добавляем обработчики для кнопок пагинации
    document.getElementById('prev-page-btn')?.addEventListener('click', () => {
      if (currentLeaderboardPage > 1) {
        loadLeaderboard(currentLeaderboardPage - 1);
      }
    });

    document.getElementById('next-page-btn')?.addEventListener('click', () => {
      if (currentLeaderboardPage < pagination.totalPages) {
        loadLeaderboard(currentLeaderboardPage + 1);
      }
    });
  } catch (error) {
    console.error('Ошибка загрузки таблицы лидеров:', error);
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
  const counterDialog = document.querySelector<CounterDialogElement>('counter-dialog');

  if (!addCommandBtn || !allLinksBtn || !commandsContainer || !commandDialog || !linkDialog || !counterDialog) {
    return;
  }

  // Переключение вкладок
  setupTabs();
  
  // Проверяем авторизацию (Nginx Basic Auth)
  const isAuthorized = await checkAuth();
  
  if (isAuthorized) {
    showAdminContent();
  } else {
    hideAdminContent();
  }

  // Публичный контент всегда загружается
  await loadLeaderboard();
  await initLinks(linkDialog);
  
  // Админский контент загружаем только если авторизованы
  if (isAuthorized) {
    await loadCommands();
    await loadCounters();
    await loadDuelsStatus();
  }

  // Кнопка добавления счётчика
  const addCounterBtn = document.getElementById('add-counter-btn');
  addCounterBtn?.addEventListener('click', () => {
    counterDialog.openForCreate();
  });

  // Обработчик событий для счётчиков
  const countersContainer = document.getElementById('counters-container');
  countersContainer?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const card = target.closest<HTMLElement>('.counter-card');
    if (!card) return;

    const encodedId = card.dataset.id;
    if (!encodedId) return;
    const id = decodeURIComponent(encodedId);

    const actionEl = target.closest<HTMLElement>('[data-action]');
    const action = actionEl?.dataset.action;

    if (!action) return;

    if (action === 'toggle') {
      try {
        await toggleCounter(id);
        await loadCounters();
        showAlert('Статус счётчика изменён');
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }
    }

    if (action === 'edit-value') {
      const newValue = prompt('Введите новое значение счётчика:');
      if (newValue !== null) {
        const parsedValue = parseInt(newValue, 10);
        if (!isNaN(parsedValue)) {
          try {
            const data = await fetchCounters();
            const counter = data.counters.find((c) => c.id === id);
            if (!counter) {
              showAlert('Счётчик не найден', 'error');
              return;
            }
            await updateCounter(id, { ...counter, value: parsedValue });
            await loadCounters();
            showAlert('Значение счётчика обновлено');
          } catch (error) {
            if (error instanceof Error) {
              showAlert(`Ошибка: ${error.message}`, 'error');
            }
          }
        } else {
          showAlert('Некорректное значение', 'error');
        }
      }
    }

    if (action === 'delete') {
      if (!confirm('Удалить счётчик?')) return;
      try {
        await deleteCounter(id);
        await loadCounters();
        showAlert('Счётчик удалён');
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка: ${error.message}`, 'error');
        }
      }
    }

    if (action === 'edit') {
      try {
        const data = await fetchCounters();
        const counter = data.counters.find((c) => c.id === id);
        if (!counter) {
          showAlert('Счётчик не найден', 'error');
          return;
        }
        counterDialog.openForEdit(counter);
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка загрузки счётчика: ${error.message}`, 'error');
        }
      }
    }
  });

  // Обработчик сохранения счётчика
  counterDialog.addEventListener('save', async (event: Event) => {
    const customEvent = event as CustomEvent<CounterDialogSaveDetail>;
    const { counter, editId } = customEvent.detail;

    try {
      if (editId) {
        await updateCounter(editId, counter);
        showAlert('Счётчик обновлён');
      } else {
        await createCounter(counter);
        showAlert('Счётчик создан');
      }
      counterDialog.close();
      await loadCounters();
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка: ${error.message}`, 'error');
      }
    }
  });

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

    const encodedId = card.dataset.id;
    if (!encodedId) return;
    const id = decodeURIComponent(encodedId);

    const messageType = card.dataset.messageType;
    const color = card.dataset.color;

    // Копирование текста по клику на триггер / алиасы / ответ
    const copySource = target.closest<HTMLElement>(
      '.command-trigger, .command-response, .alias-tag',
    );
    if (copySource) {
      let textToCopy = copySource.textContent?.trim() ?? '';

      // Для объявлений при копировании ответа сразу формируем /announce-команду.
      // С учётом цветных вариантов Twitch: /announceblue, /announceorange и т.п.
      if (copySource.classList.contains('command-response') && messageType === 'announcement') {
        const colorSuffix =
          color && color !== 'primary'
            ? color
            : '';

        const announceCommand = colorSuffix
          ? `/announce${colorSuffix}`
          : '/announce';

        textToCopy = `${announceCommand} ${textToCopy}`;
      }

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

    const actionEl = target.closest<HTMLElement>('[data-action]');
    const action = actionEl?.dataset.action;

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

    if (action === 'send') {
      if (card.classList.contains('disabled')) {
        showAlert('Команда выключена. Включи её, чтобы отправить в чат.', 'error');
        return;
      }
      try {
        await fetch(`/api/commands/${encodeURIComponent(id)}/send`, {
          method: 'POST',
        });
        showAlert('Команда отправлена в чат');
      } catch (error) {
        if (error instanceof Error) {
          showAlert(`Ошибка отправки команды: ${error.message}`, 'error');
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

  linkDialog.addEventListener('send', async () => {
    try {
      await fetch('/api/links/send', { method: 'POST' });
      showAlert('Ссылки отправлены в чат');
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка отправки ссылок: ${error.message}`, 'error');
      }
    }
  });

  // Админ панель - кнопки управления дуэлями
  const enableDuelsBtn = document.getElementById('enable-duels-btn');
  const disableDuelsBtn = document.getElementById('disable-duels-btn');
  const pardonAllBtn = document.getElementById('pardon-all-btn');

  enableDuelsBtn?.addEventListener('click', async () => {
    try {
      await fetch('/api/admin/duels/enable', { method: 'POST' });
      showAlert('Дуэли включены');
      await loadDuelsStatus();
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка: ${error.message}`, 'error');
      }
    }
  });

  disableDuelsBtn?.addEventListener('click', async () => {
    try {
      await fetch('/api/admin/duels/disable', { method: 'POST' });
      showAlert('Дуэли выключены');
      await loadDuelsStatus();
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка: ${error.message}`, 'error');
      }
    }
  });

  pardonAllBtn?.addEventListener('click', async () => {
    if (!confirm('Простить всех игроков (снять таймауты дуэлей)?')) return;
    try {
      await fetch('/api/admin/pardon-all', { method: 'POST' });
      showAlert('Амнистия выполнена, все таймауты сняты');
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка: ${error.message}`, 'error');
      }
    }
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
});

