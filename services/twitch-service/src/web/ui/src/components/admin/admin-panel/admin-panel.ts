// @ts-ignore
import template from './admin-panel.html?raw';
import './admin-panel.scss';
import { showAlert } from '../../../alerts';
import {
  authFetch,
  fetchFriendsShoutoutConfig,
  fetchLinksConfig,
  fetchRaidConfig,
  login,
  updateFriendsShoutoutConfig,
  updateLinksConfig,
  updateRaidConfig,
} from '../../../api';
import type { LinkDialogElement } from '../dialog/link-dialog/link-dialog';
import type { LinkDialogSaveDetail } from '../../../interfaces/link-dialog';
import { clearAdminAuth, getAdminPassword, setAdminPassword } from '../../../admin-auth';
import type { FriendsShoutoutDialogElement } from '../dialog/friends-shoutout-dialog/friends-shoutout-dialog';

const VALID_TABS = ['commands', 'counters', 'duels', 'party', 'moderation', 'logs', 'admin-logs'] as const;

function getAdminTabFromHash(): (typeof VALID_TABS)[number] {
  const hash = window.location.hash.slice(1).toLowerCase();
  return VALID_TABS.includes(hash as (typeof VALID_TABS)[number]) ? (hash as (typeof VALID_TABS)[number]) : 'commands';
}

function updateAdminHash(tab: string): void {
  const url = new URL(window.location.href);
  url.hash = tab === 'commands' ? '' : tab;
  history.replaceState(null, '', url.toString());
}

export class AdminPanelElement extends HTMLElement {
  private initialized = false;
  private lastLinksRotationMinutes: number | null = null;
  private lastRaidMessage: string | null = null;
  private hashChangeHandler: (() => void) | null = null;
  private readonly friendsShoutoutCollapseStorageKey = 'admin.friendsShoutoutCollapsed';

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.setupAuthModal();
    window.addEventListener('admin-auth-required', this.handleAuthRequired);
    if (getAdminPassword()) {
      this.showPanel();
      this.setupTabs();
      this.setupLogout();
      this.setupCommandsTab();
    } else {
      this.showAuthModal();
    }
  }

  disconnectedCallback(): void {
    window.removeEventListener('admin-auth-required', this.handleAuthRequired);
    if (this.hashChangeHandler) {
      window.removeEventListener('hashchange', this.hashChangeHandler);
      this.hashChangeHandler = null;
    }
  }

  private handleAuthRequired = (): void => {
    this.showAuthModal();
  };

  private showAuthModal(): void {
    const modal = this.querySelector('#auth-modal');
    const container = this.querySelector('#admin-panel-container');
    if (modal) modal.classList.add('active');
    if (container) (container as HTMLElement).style.display = 'none';
  }

  private showPanel(): void {
    const modal = this.querySelector('#auth-modal');
    const container = this.querySelector('#admin-panel-container');
    if (modal) modal.classList.remove('active');
    if (container) (container as HTMLElement).style.display = '';
  }

  private setupAuthModal(): void {
    const form = this.querySelector<HTMLFormElement>('#auth-form');
    const usernameInput = this.querySelector<HTMLInputElement>('#auth-username');
    const passwordInput = this.querySelector<HTMLInputElement>('#auth-password');
    const errorEl = this.querySelector<HTMLElement>('#auth-error');
    const submitBtn = this.querySelector<HTMLButtonElement>('#auth-submit-btn');

    this.querySelector('#auth-cancel-btn')?.addEventListener('click', () => {
      window.location.href = '/public';
    });

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = usernameInput?.value?.trim();
      const password = passwordInput?.value;
      if (!username || !password || !errorEl || !submitBtn) return;
      errorEl.style.display = 'none';
      errorEl.textContent = '';
      submitBtn.disabled = true;
      try {
        const { token } = await login(username, password);
        setAdminPassword(token);
        this.showPanel();
        this.setupTabs();
        this.setupLogout();
        this.setupCommandsTab();
        window.dispatchEvent(new CustomEvent('admin-auth-success'));
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : 'Ошибка входа';
        errorEl.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  private setupTabs(): void {
    const root = this;
    const tabButtons = root.querySelectorAll<HTMLButtonElement>('.tab-btn');
    const tabContents = root.querySelectorAll<HTMLElement>('.tab-content');
    const tabsContainer = root.querySelector<HTMLElement>('.tabs');

    const applyTab = (targetTab: string): void => {
      const btn = root.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${targetTab}"]`);
      if (!btn) return;
      tabButtons.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => {
        c.classList.remove('active');
        (c as HTMLElement).style.display = 'none';
      });
      btn.classList.add('active');
      const targetContent = root.querySelector(`#tab-${targetTab}`);
      if (targetContent) {
        targetContent.classList.add('active');
        (targetContent as HTMLElement).style.display = 'block';
      }

      // Чтобы в "Журналах" всегда появлялись новые сообщения,
      // инициируем принудительную загрузку при каждом заходе на вкладку.
      if (targetTab === 'logs') {
        window.dispatchEvent(new CustomEvent('admin-logs-open'));
      }
      if (targetTab === 'admin-logs') {
        window.dispatchEvent(new CustomEvent('admin-admin-logs-open'));
      }
      if (tabsContainer) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    };

    const initialTab = getAdminTabFromHash();
    applyTab(initialTab);

    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        if (!targetTab) return;
        updateAdminHash(targetTab);
        applyTab(targetTab);
      });
    });

    if (this.hashChangeHandler) {
      window.removeEventListener('hashchange', this.hashChangeHandler);
    }
    this.hashChangeHandler = () => {
      if (getAdminPassword()) applyTab(getAdminTabFromHash());
    };
    window.addEventListener('hashchange', this.hashChangeHandler);
  }

  private setupLogout(): void {
    this.querySelector('#logout-btn')?.addEventListener('click', () => {
      clearAdminAuth();
      window.location.href = '/public';
    });
  }

  private setupCommandsTab(): void {
    const allLinksBtn = this.querySelector('#all-links-btn');
    const linkDialog = document.querySelector<LinkDialogElement>('link-dialog');
    if (!allLinksBtn || !linkDialog) return;

    const friendsBtn = this.querySelector<HTMLButtonElement>('#friends-shoutout-btn');
    const friendsToggle = this.querySelector<HTMLElement>('#friends-shoutout-enabled');
    this.setupFriendsShoutoutCollapse();

    const raidMessageInput = this.querySelector<HTMLTextAreaElement>('#raid-message');
    const raidSaveBtn = this.querySelector<HTMLButtonElement>('#raid-save-btn');
    const updateRaidSaveButton = (): void => {
      if (!raidMessageInput || !raidSaveBtn) return;
      const current = raidMessageInput.value;
      raidSaveBtn.disabled = this.lastRaidMessage === null || this.lastRaidMessage === current;
    };

    void this.initLinks(linkDialog, updateRaidSaveButton);

    allLinksBtn.addEventListener('click', async () => {
      try {
        const config = await fetchLinksConfig();
        linkDialog.open({ allLinksText: config.allLinksText ?? '' });
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка загрузки ссылок: ${error.message}`, 'error');
      }
    });

    friendsBtn?.addEventListener('click', () => {
      // Важно: ищем элемент при клике, чтобы не зависеть от порядка создания DOM в innerHTML
      const dlg = document.querySelector<FriendsShoutoutDialogElement>('friends-shoutout-dialog');
      if (!dlg) {
        showAlert('Диалог не найден на странице (friends-shoutout-dialog)', 'error');
        return;
      }
      void dlg.open();
    });

    friendsToggle?.addEventListener('click', () => {
      if (!friendsToggle) return;
      const enabled = friendsToggle.getAttribute('data-enabled') === 'true';
      const next = !enabled;
      friendsToggle.classList.toggle('on', next);
      friendsToggle.classList.toggle('off', !next);
      friendsToggle.setAttribute('data-enabled', String(next));
      const textEl = friendsToggle.querySelector('.status-toggle-text');
      if (textEl) textEl.textContent = next ? 'ВКЛ' : 'ВЫКЛ';
      void (async () => {
        try {
          const current = await fetchFriendsShoutoutConfig().catch(() => ({ enabled: false, logins: [] as string[] }));
          const updated = await updateFriendsShoutoutConfig({ enabled: next, logins: current.logins ?? [] });
          const applied = Boolean(updated.enabled);
          friendsToggle.classList.toggle('on', applied);
          friendsToggle.classList.toggle('off', !applied);
          friendsToggle.setAttribute('data-enabled', String(applied));
          const t = friendsToggle.querySelector('.status-toggle-text');
          if (t) t.textContent = applied ? 'ВКЛ' : 'ВЫКЛ';
          showAlert('Настройка авто-шатаута сохранена', 'success');
        } catch (error) {
          // Откат UI обратно
          friendsToggle.classList.toggle('on', enabled);
          friendsToggle.classList.toggle('off', !enabled);
          friendsToggle.setAttribute('data-enabled', String(enabled));
          const t = friendsToggle.querySelector('.status-toggle-text');
          if (t) t.textContent = enabled ? 'ВКЛ' : 'ВЫКЛ';
          if (error instanceof Error) showAlert(`Ошибка сохранения: ${error.message}`, 'error');
        }
      })();
    });

    linkDialog.addEventListener('save', async (event: Event) => {
      const customEvent = event as CustomEvent<LinkDialogSaveDetail>;
      const { allLinksText } = customEvent.detail;
      try {
        await updateLinksConfig({ allLinksText });
        linkDialog.close();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка сохранения ссылок: ${error.message}`, 'error');
      }
    });

    linkDialog.addEventListener('send', async () => {
      try {
        await authFetch('/api/links/send', { method: 'POST' });
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка отправки ссылок: ${error.message}`, 'error');
      }
    });

    const linksIntervalInput = this.querySelector<HTMLInputElement>('#links-rotation-interval-min');
    const linksSaveBtn = this.querySelector<HTMLButtonElement>('#links-rotation-save-btn');

    const updateLinksSaveButton = (): void => {
      if (!linksIntervalInput || !linksSaveBtn) return;
      const current = parseInt(linksIntervalInput.value, 10) || 0;
      const same = this.lastLinksRotationMinutes !== null && this.lastLinksRotationMinutes === current;
      linksSaveBtn.disabled = same || current <= 0;
    };

    linksIntervalInput?.addEventListener('input', updateLinksSaveButton);
    linksIntervalInput?.addEventListener('change', updateLinksSaveButton);

    linksSaveBtn?.addEventListener('click', async () => {
      if (!linksIntervalInput) return;
      const raw = parseInt(linksIntervalInput.value, 10) || 0;
      const safeMinutes = Math.max(1, Math.min(120, raw));
      try {
        const config = await fetchLinksConfig();
        const updated = await updateLinksConfig({
          allLinksText: config.allLinksText ?? '',
          rotationIntervalMinutes: safeMinutes,
        });
        this.lastLinksRotationMinutes = updated.rotationIntervalMinutes ?? safeMinutes;
        linksIntervalInput.value = String(this.lastLinksRotationMinutes);
        updateLinksSaveButton();
        showAlert('Интервал ротации ссылок сохранён', 'success');
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка сохранения интервала ротации: ${error.message}`, 'error');
      }
    });

    const resizeRaidInput = (): void => {
      if (!raidMessageInput) return;
      raidMessageInput.style.height = '1px';
      const raw = raidMessageInput.scrollHeight;
      raidMessageInput.style.height = `${Math.min(Math.max(raw + 4, 40), 160)}px`;
    };
    raidMessageInput?.addEventListener('input', () => {
      updateRaidSaveButton();
      resizeRaidInput();
    });
    raidMessageInput?.addEventListener('change', updateRaidSaveButton);

    raidSaveBtn?.addEventListener('click', async () => {
      const message = raidMessageInput?.value ?? '';
      try {
        await updateRaidConfig({ raidMessage: message });
        this.lastRaidMessage = message;
        updateRaidSaveButton();
        showAlert('Сообщение при рейде сохранено', 'success');
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка сохранения: ${error.message}`, 'error');
      }
    });
  }

  private setupFriendsShoutoutCollapse(): void {
    const section = this.querySelector<HTMLElement>('#friends-shoutout-section');
    const content = this.querySelector<HTMLElement>('#friends-shoutout-content');
    const collapseBtn = this.querySelector<HTMLButtonElement>('#friends-shoutout-collapse-btn');
    if (!section || !content || !collapseBtn) return;

    const apply = (collapsed: boolean): void => {
      section.classList.toggle('collapsed', collapsed);
      content.style.display = collapsed ? 'none' : '';
      collapseBtn.textContent = collapsed ? 'Показать' : 'Скрыть';
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    };

    const stored = window.localStorage.getItem(this.friendsShoutoutCollapseStorageKey);
    apply(stored === 'true');

    collapseBtn.addEventListener('click', () => {
      const nextCollapsed = !section.classList.contains('collapsed');
      apply(nextCollapsed);
      window.localStorage.setItem(this.friendsShoutoutCollapseStorageKey, String(nextCollapsed));
    });
  }

  private async initLinks(
    linkDialog: LinkDialogElement,
    onLoaded?: () => void,
  ): Promise<void> {
    try {
      const [linksConfig, raidConfig, friendsConfig] = await Promise.all([
        fetchLinksConfig(),
        fetchRaidConfig(),
        fetchFriendsShoutoutConfig().catch(() => ({ enabled: false, logins: [] as string[] })),
      ]);
      this.lastLinksRotationMinutes = linksConfig.rotationIntervalMinutes ?? 13;
      const linksIntervalInput = this.querySelector<HTMLInputElement>('#links-rotation-interval-min');
      if (linksIntervalInput) linksIntervalInput.value = String(this.lastLinksRotationMinutes);
      const raidMessageInput = this.querySelector<HTMLTextAreaElement>('#raid-message');
      if (raidMessageInput) {
        raidMessageInput.value = raidConfig.raidMessage ?? '';
        this.lastRaidMessage = raidConfig.raidMessage ?? '';
        raidMessageInput.style.height = '1px';
        const raw = raidMessageInput.scrollHeight;
        raidMessageInput.style.height = `${Math.min(Math.max(raw + 4, 40), 160)}px`;
      }
      const friendsToggle = this.querySelector<HTMLInputElement>('#friends-shoutout-enabled');
      const friendsToggleEl = this.querySelector<HTMLElement>('#friends-shoutout-enabled');
      if (friendsToggleEl) {
        const enabled = Boolean(friendsConfig.enabled);
        friendsToggleEl.classList.toggle('on', enabled);
        friendsToggleEl.classList.toggle('off', !enabled);
        friendsToggleEl.setAttribute('data-enabled', String(enabled));
        const textEl = friendsToggleEl.querySelector('.status-toggle-text');
        if (textEl) textEl.textContent = enabled ? 'ВКЛ' : 'ВЫКЛ';
      }
      linkDialog.open({ allLinksText: linksConfig.allLinksText ?? '' });
      linkDialog.close();
      onLoaded?.();
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки: ${error.message}`, 'error');
      }
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'admin-panel': AdminPanelElement;
  }
}

customElements.define('admin-panel', AdminPanelElement);
