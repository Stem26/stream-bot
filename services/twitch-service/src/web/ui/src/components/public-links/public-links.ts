import template from './public-links.html?raw';
import './public-links.scss';

export class PublicLinksElement extends HTMLElement {
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'public-links': PublicLinksElement;
  }
}

customElements.define('public-links', PublicLinksElement);
