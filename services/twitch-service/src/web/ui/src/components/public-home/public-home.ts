import template from './public-home.html?raw';
import './public-home.scss';

export class PublicHomeElement extends HTMLElement {
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.innerHTML = template;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'public-home': PublicHomeElement;
  }
}

customElements.define('public-home', PublicHomeElement);
