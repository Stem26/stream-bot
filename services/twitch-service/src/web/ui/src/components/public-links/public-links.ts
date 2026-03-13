import template from './public-links.html?raw';
import './public-links.scss';
import chevronIcon from '../../icons/24px_chevron_left.svg?raw';

export class PublicLinksElement extends HTMLElement {
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
    
    // Вставляем SVG иконку
    const backBtn = this.querySelector('.back-btn');
    if (backBtn) {
      backBtn.innerHTML = chevronIcon;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'public-links': PublicLinksElement;
  }
}

customElements.define('public-links', PublicLinksElement);
