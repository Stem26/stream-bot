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
  fetchPartyItems,
  createPartyItem,
  updatePartyItem,
  deletePartyItem,
  fetchPartyConfig,
  updatePartyConfig,
  setPartySkipCooldown,
} from './api';
import type { CommandsData, CustomCommand, CountersData, Counter, PartyItemsData } from './types';
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
      tabContents.forEach((c) => {
        c.classList.remove('active');
        c.style.display = 'none';
      });

      // Добавляем active к выбранным
      btn.classList.add('active');
      const targetContent = document.getElementById(`tab-${targetTab}`);
      if (targetContent) {
        targetContent.classList.add('active');
        targetContent.style.display = 'block';
      }
    });
  });
}

function renderCommands(data: CommandsData): void {
  const container = document.getElementById('commands-container');
  const emptyState = document.getElementById('empty-state');
  if (!container || !emptyState) return;

  // Всегда показываем контейнер
  container.style.display = 'grid';
  emptyState.style.display = 'none';

  // Создаем карточку для добавления команды
  const addCommandCard = `
    <div class="command-card add-command-card" id="add-command-card-trigger">
      <div class="add-command-content">
        <div class="add-command-icon">+</div>
        <div class="add-command-text">Добавить команду</div>
      </div>
    </div>
  `;

  const attr = (s: string) => String(s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
  const commandCards = data.commands
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

        <div class="command-description-slot"><div class="command-description ${cmd.description ? '' : 'empty'}"${cmd.description ? ` title="${attr(cmd.description)}"` : ''}>${cmd.description || '\u00A0'}</div></div>

        <div class="command-response" title="${attr(cmd.response)}">${cmd.response}</div>

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

  // Добавляем карточку "+" в начало + остальные команды
  container.innerHTML = addCommandCard + commandCards;
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
  if (!container) return;

  container.style.display = 'grid';

  const addCounterCard = `
    <div class="command-card add-command-card" id="add-counter-card-trigger">
      <div class="add-command-content">
        <div class="add-command-icon">+</div>
        <div class="add-command-text">Добавить счётчик</div>
      </div>
    </div>
  `;

  const variantsText = (t: string) => `${t}инфо · ${t}откат · ${t}[число]`;
  const attr = (s: string) => String(s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
  const counterCards = data.counters
    .map(
      (counter) => {
        const encodedId = encodeURIComponent(counter.id);
        const variants = variantsText(counter.trigger);
        const templateFull = `Шаблон ответа: ${counter.responseTemplate}`;
        return `
      <div
        class="command-card counter-card ${counter.enabled ? '' : 'disabled'}"
        data-id="${encodedId}"
      >
        <div class="command-header">
          <div class="command-trigger">
            ${counter.trigger}
            <span class="counter-variants" title="${attr(variants)}">${variants}</span>
          </div>
          <div class="command-status">
            <div class="status-toggle ${counter.enabled ? 'on' : 'off'}" data-action="toggle">
              <div class="status-toggle-circle"></div>
              <span class="status-toggle-text">${counter.enabled ? 'ВКЛ' : 'ВЫКЛ'}</span>
            </div>
          </div>
        </div>

        <div class="counter-description-slot"><div class="command-description ${counter.description ? '' : 'empty'}"${counter.description ? ` title="${attr(counter.description)}"` : ''}>${counter.description || '\u00A0'}</div></div>

        <div class="counter-value-display">
          <div class="counter-label">Текущее значение:</div>
          <div class="counter-value">${counter.value}</div>
        </div>

        <div class="counter-template" title="${attr(templateFull)}">
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

  container.innerHTML = addCounterCard + counterCards;
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

function renderPartyItems(data: PartyItemsData): void {
  const container = document.getElementById('party-items-container');
  if (!container) return;

  container.style.display = 'grid';

  const addPartyCard = `
    <div class="command-card add-command-card" id="add-party-item-card-trigger">
      <div class="add-command-content">
        <div class="add-command-icon">+</div>
        <div class="add-command-text">Добавить элемент</div>
      </div>
    </div>
  `;

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const attr = (s: string) => String(s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
  const itemCards = data.items
    .map(
      (item) => `
    <div class="command-card party-item-card" data-id="${item.id}">
      <div class="command-response" title="${attr(item.text)}">${esc(item.text)}</div>
      <div class="command-actions">
        <button class="btn btn-small" data-action="edit">✏️ Изменить</button>
        <button class="btn btn-small btn-danger" data-action="delete">🗑️ Удалить</button>
      </div>
    </div>
  `,
    )
    .join('');

  container.innerHTML = addPartyCard + itemCards;
}

async function loadPartyItems(): Promise<void> {
  try {
    const data = await fetchPartyItems();
    renderPartyItems(data);
  } catch (error) {
    if (error instanceof Error) {
      showAlert(`Ошибка загрузки партии: ${error.message}`, 'error');
    }
  }
}

async function loadPartyConfig(): Promise<void> {
  try {
    const config = await fetchPartyConfig();
    const ec = document.getElementById('party-elements-count') as HTMLInputElement;
    const qm = document.getElementById('party-quantity-max') as HTMLInputElement;
    const toggle = document.getElementById('party-skip-cooldown-toggle');
    if (ec) ec.value = String(config.elementsCount);
    if (qm) qm.value = String(config.quantityMax);
    if (toggle) {
      const on = config.skipCooldown;
      toggle.classList.toggle('on', on);
      toggle.classList.toggle('off', !on);
      toggle.dataset.enabled = String(on);
      const textEl = toggle.querySelector('.status-toggle-text');
      if (textEl) textEl.textContent = on ? 'Ограничение ВЫКЛ' : 'Ограничение ВКЛ';
    }
  } catch (error) {
    if (error instanceof Error) {
      showAlert(`Ошибка загрузки настроек партии: ${error.message}`, 'error');
    }
  }
}

async function loadDuelsStatus(): Promise<boolean> {
  try {
    const response = await fetch('/api/admin/duels/status');
    const data = await response.json();
    const toggle = document.getElementById('duels-toggle');
    if (toggle) {
      const enabled = Boolean(data.enabled);
      toggle.classList.toggle('on', enabled);
      toggle.classList.toggle('off', !enabled);
      toggle.dataset.enabled = String(enabled);
      const textEl = toggle.querySelector('.status-toggle-text');
      if (textEl) textEl.textContent = enabled ? 'ВКЛ' : 'ВЫКЛ';
    }
    return Boolean(data.enabled);
  } catch (error) {
    console.error('Ошибка загрузки статуса дуэлей:', error);
    return false;
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
  const allLinksBtn = document.getElementById('all-links-btn');
  const commandsContainer = document.getElementById('commands-container');

  const commandDialog = document.querySelector<CommandDialogElement>('command-dialog');
  const linkDialog = document.querySelector<LinkDialogElement>('link-dialog');
  const counterDialog = document.querySelector<CounterDialogElement>('counter-dialog');

  if (!allLinksBtn || !commandsContainer || !commandDialog || !linkDialog || !counterDialog) {
    return;
  }

  // Переключение вкладок
  setupTabs();
  
  // Загружаем данные
  await initLinks(linkDialog);
  await loadCommands();
  await loadCounters();
  await loadDuelsStatus();
  await loadPartyItems();
  await loadPartyConfig();

  // Карточки "Добавить" (команды, счётчики, партия)
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('#add-command-card-trigger')) {
      commandDialog.openForCreate();
    } else if (target.closest('#add-counter-card-trigger')) {
      counterDialog.openForCreate();
    } else if (target.closest('#add-party-item-card-trigger')) {
      (async () => {
        const text = prompt('Элемент (например: хомяко‑адвоката):');
        if (!text?.trim()) return;
        try {
          await createPartyItem(text.trim());
          showAlert('Элемент добавлен');
          await loadPartyItems();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
      })();
    }
  });

  // Партия: переключатель «без кулдауна» (тест)
  const partySkipCooldownToggle = document.getElementById('party-skip-cooldown-toggle');
  partySkipCooldownToggle?.addEventListener('click', async () => {
    const on = partySkipCooldownToggle.dataset.enabled === 'true';
    const newVal = !on;
    try {
      await setPartySkipCooldown(newVal);
      partySkipCooldownToggle.dataset.enabled = String(newVal);
      partySkipCooldownToggle.classList.toggle('on', newVal);
      partySkipCooldownToggle.classList.toggle('off', !newVal);
      const textEl = partySkipCooldownToggle.querySelector('.status-toggle-text');
      if (textEl) textEl.textContent = newVal ? 'Ограничение ВЫКЛ' : 'Ограничение ВКЛ';
      showAlert(newVal ? 'Тестовый режим: кулдаун отключён' : 'Кулдаун включён (раз в сутки)');
    } catch (error) {
      if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
    }
  });

  // Партия: сохранить настройки
  const partyConfigSaveBtn = document.getElementById('party-config-save-btn');
  partyConfigSaveBtn?.addEventListener('click', async () => {
    const ec = document.getElementById('party-elements-count') as HTMLInputElement;
    const qm = document.getElementById('party-quantity-max') as HTMLInputElement;
    const elementsCount = Math.min(10, Math.max(1, parseInt(ec?.value || '2', 10) || 2));
    const quantityMax = Math.min(99, Math.max(1, parseInt(qm?.value || '4', 10) || 4));
    try {
      const toggle = document.getElementById('party-skip-cooldown-toggle');
      const skipCooldown = toggle?.dataset.enabled === 'true';
      await updatePartyConfig({ elementsCount, quantityMax, skipCooldown: skipCooldown ?? false });
      showAlert('Настройки сохранены');
    } catch (error) {
      if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
    }
  });

  // Партия: редактирование и удаление
  const partyItemsContainer = document.getElementById('party-items-container');
  partyItemsContainer?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>('.party-item-card');
    if (!card) return;
    const id = parseInt(card.dataset.id ?? '', 10);
    if (isNaN(id)) return;

    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'edit') {
      const data = await fetchPartyItems();
      const item = data.items.find((i) => i.id === id);
      if (!item) return;
      const text = prompt('Элемент:', item.text);
      if (text === null || !text.trim()) return;
      try {
        await updatePartyItem(id, text.trim());
        showAlert('Элемент обновлён');
        await loadPartyItems();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    }
    if (action === 'delete') {
      if (!confirm('Удалить элемент?')) return;
      try {
        await deletePartyItem(id);
        showAlert('Элемент удалён');
        await loadPartyItems();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    }
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
        const res = await fetch(`/api/commands/${encodeURIComponent(id)}/send`, {
          method: 'POST',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
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

  // Админ панель - тоггл управления дуэлями
  const duelsToggle = document.getElementById('duels-toggle');
  const pardonAllBtn = document.getElementById('pardon-all-btn');

  duelsToggle?.addEventListener('click', async () => {
    const enabled = duelsToggle.dataset.enabled === 'true';
    const endpoint = enabled ? '/api/admin/duels/disable' : '/api/admin/duels/enable';
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      showAlert(enabled ? 'Дуэли выключены' : 'Дуэли включены');
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
      const res = await fetch('/api/admin/pardon-all', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
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

