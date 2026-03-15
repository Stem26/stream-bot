import template from './moderation-rules-dialog.html?raw';
import './moderation-rules-dialog.scss';
import { createModal } from '../../utils/modal';
import type { ChatModerationConfig } from '../../types';

export interface ModerationRulesDialogElement extends HTMLElement {
  open(config?: ChatModerationConfig): void;
  close(): void;
}

customElements.define(
  'moderation-rules-dialog',
  class extends HTMLElement implements ModerationRulesDialogElement {
    private modal!: ReturnType<typeof createModal>;

    connectedCallback(): void {
      this.innerHTML = template;
      this.modal = createModal(() => this.querySelector('.modal'));

      this.querySelectorAll<HTMLElement>('[data-close]').forEach((btn) => {
        btn.addEventListener('click', () => this.close());
      });
    }

    open(config?: ChatModerationConfig): void {
      void config; // пока в тексте правил используем только общую формулировку
      this.modal.show();
    }

    close(): void {
      this.modal.hide();
    }

    disconnectedCallback(): void {
      this.modal?.cleanup();
    }
  }
);
