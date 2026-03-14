export interface ModalBehavior {
  show(): void;
  hide(): void;
  cleanup(): void;
}

export function createModal(getModal: () => HTMLElement | null): ModalBehavior {
  const getEl = getModal;
  let escHandler: ((e: KeyboardEvent) => void) | undefined;

  const hide = (): void => {
    getEl()?.classList.remove('active');
    document.body.classList.remove('modal-open');
  };

  const show = (): void => {
    getEl()?.classList.add('active');
    document.body.classList.add('modal-open');
    if (!escHandler) {
      escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') hide();
      };
      document.addEventListener('keydown', escHandler);
    }
  };

  const cleanup = (): void => {
    if (escHandler) {
      document.removeEventListener('keydown', escHandler);
      escHandler = undefined;
    }
  };

  return { show, hide, cleanup };
}
