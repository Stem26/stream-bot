// @ts-ignore
import template from './counters-table.html?raw';
import './counters-table.scss';
import { showAlert } from '../../../../alerts';
import {
  fetchCounters,
  createCounter,
  updateCounter,
  deleteCounter,
  toggleCounter,
} from '../../../../api';
import type { CountersData } from '../../../../types';
import type { CounterDialogElement, CounterDialogSaveDetail, CounterDialogDeleteDetail } from '../../dialog/counter-dialog/counter-dialog';
import { getAdminPassword } from '../../../../admin-auth';

export class CountersTableElement extends HTMLElement {
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    this.setupHandlers();
    if (getAdminPassword()) void this.loadCounters();
    window.addEventListener('admin-auth-success', this.handleAuthSuccess);
  }

  disconnectedCallback(): void {
    window.removeEventListener('admin-auth-success', this.handleAuthSuccess);
  }

  private handleAuthSuccess = (): void => {
    void this.loadCounters();
  };

  private getTemplate(id: string): HTMLTemplateElement | null {
    return this.querySelector<HTMLTemplateElement>(`#${id}`);
  }

  private renderCounters(data: CountersData): void {
    const container = this.querySelector<HTMLElement>('#counters-container');
    const table = this.querySelector<HTMLTableElement>('#counters-table');
    const tbody = this.querySelector<HTMLTableSectionElement>('#counters-tbody');
    const emptyState = this.querySelector<HTMLElement>('#counters-empty-state');
    if (!container || !table || !tbody || !emptyState) return;

    container.classList.remove('loading-state');
    const loadingEl = container.querySelector('.loading');
    if (loadingEl) (loadingEl as HTMLElement).style.display = 'none';
    tbody.innerHTML = '';

    const rowTpl = this.getTemplate('template-counter-row');
    if (!rowTpl || !data.counters.length) {
      table.style.display = 'none';
      emptyState.style.display = data.counters.length === 0 ? 'block' : 'none';
      return;
    }

    table.style.display = 'table';
    emptyState.style.display = 'none';

    data.counters.forEach((counter, index) => {
      const tr = rowTpl.content.cloneNode(true) as DocumentFragment;
      const row = tr.firstElementChild as HTMLTableRowElement;
      if (!row) return;
      row.dataset.id = encodeURIComponent(counter.id);
      row.classList.toggle('disabled', !counter.enabled);

      const numCell = row.querySelector('.col-num');
      const triggerCell = row.querySelector('.col-trigger .trigger-text');
      const valueCell = row.querySelector('.col-value');
      const descCell = row.querySelector('.col-description');
      const statusBtn = row.querySelector<HTMLButtonElement>('.col-status .status-badge');

      if (numCell) numCell.textContent = String(index + 1);
      if (triggerCell) triggerCell.textContent = counter.trigger;
      if (valueCell) valueCell.textContent = String(counter.value);
      if (descCell) {
        const tpl = counter.responseTemplate || '';
        descCell.textContent = tpl || '—';
        if (tpl) descCell.setAttribute('title', tpl);
      }
      if (statusBtn) {
        statusBtn.textContent = counter.enabled ? 'ВКЛ' : 'ВЫКЛ';
        statusBtn.classList.toggle('on', counter.enabled);
        statusBtn.classList.toggle('off', !counter.enabled);
      }
      tbody.appendChild(tr);
    });
  }

  async loadCounters(): Promise<void> {
    try {
      const data = await fetchCounters();
      this.renderCounters(data);
    } catch (error) {
      if (error instanceof Error) {
        showAlert(`Ошибка загрузки счётчиков: ${error.message}`, 'error');
      }
    }
  }

  private setupHandlers(): void {
    const countersContainer = this.querySelector('#counters-container');
    const addBtn = this.querySelector('#add-counter-btn');
    const counterDialog = document.querySelector<CounterDialogElement>('counter-dialog');

    if (!counterDialog) return;

    addBtn?.addEventListener('click', () => counterDialog.openForCreate());

    counterDialog.addEventListener('save', async (event: Event) => {
      const customEvent = event as CustomEvent<CounterDialogSaveDetail>;
      const { counter, editId } = customEvent.detail;
      try {
        if (editId) {
          await updateCounter(editId, counter);
        } else {
          await createCounter(counter);
        }
        counterDialog.close();
        await this.loadCounters();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    counterDialog.addEventListener('delete', async (event: Event) => {
      const customEvent = event as CustomEvent<CounterDialogDeleteDetail>;
      const { id } = customEvent.detail;
      if (!id) return;
      if (!confirm('Удалить счётчик?')) return;
      try {
        await deleteCounter(id);
        counterDialog.close();
        await this.loadCounters();
      } catch (error) {
        if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
      }
    });

    countersContainer?.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const row = target.closest<HTMLElement>('.counter-table-row');
      const actionBtn = target.closest<HTMLElement>('[data-action]');
      const action = actionBtn?.getAttribute('data-action');

      if (action === 'toggle' && row) {
        const encodedId = row.getAttribute('data-id');
        if (!encodedId) return;
        try {
          await toggleCounter(decodeURIComponent(encodedId));
          await this.loadCounters();
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка: ${error.message}`, 'error');
        }
        return;
      }

      if (action === 'edit' && row) {
        const encodedId = row.getAttribute('data-id');
        if (!encodedId) return;
        try {
          const data = await fetchCounters();
          const counter = data.counters.find((c) => c.id === decodeURIComponent(encodedId));
          if (!counter) {
            showAlert('Счётчик не найден', 'error');
            return;
          }
          counterDialog.openForEdit(counter);
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка загрузки счётчика: ${error.message}`, 'error');
        }
        return;
      }

      if (row && !actionBtn) {
        const encodedId = row.getAttribute('data-id');
        if (!encodedId) return;
        try {
          const data = await fetchCounters();
          const counter = data.counters.find((c) => c.id === decodeURIComponent(encodedId));
          if (!counter) return;
          counterDialog.openForEdit(counter);
        } catch (error) {
          if (error instanceof Error) showAlert(`Ошибка загрузки счётчика: ${error.message}`, 'error');
        }
      }
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'counters-table': CountersTableElement;
  }
}

customElements.define('counters-table', CountersTableElement);
