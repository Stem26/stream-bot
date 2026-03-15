import './public-base.scss';
import './styles.scss';
import './components/public-home/public-home';
import './components/public-duel/public-duel';
import './components/public-links/public-links';
import './components/command-dialog/command-dialog';
import './components/link-dialog/link-dialog';
import './components/counter-dialog/counter-dialog';
import './components/party-dialog/party-dialog';
import './components/moderation-rules-dialog/moderation-rules-dialog';
import './components/admin-panel/admin-panel';

const TITLES: Record<string, string> = {
  public: 'kunilika666 - Twitch стример',
  'public/duel': 'Таблица лидеров - kunilika666',
  'public/links': 'Ссылки - kunilika666',
  admin: 'Админ-панель - Twitch бот',
};

function getRoute(): string {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  if (path === '/') return 'public';
  if (path.startsWith('/admin')) return 'admin';
  if (path.startsWith('/public/duel')) return 'public/duel';
  if (path.startsWith('/public/links')) return 'public/links';
  if (path.startsWith('/public')) return 'public';
  return 'public';
}

function render(): void {
  const app = document.getElementById('app');
  if (!app) {
    return;
  }

  const route = getRoute();
  document.title = TITLES[route] ?? TITLES.public;
  document.body.className = 'page-' + route.replace('/', '-');

  document.querySelector('.btn-back-fixed')?.remove();
  app.innerHTML = '';

  if (route === 'admin') {
    const back = document.createElement('a');
    back.href = '/public';
    back.className = 'btn btn-back-fixed';
    back.textContent = 'На главную';
    document.body.prepend(back);
    app.innerHTML = '<admin-panel></admin-panel><command-dialog></command-dialog><link-dialog></link-dialog><counter-dialog></counter-dialog><party-dialog></party-dialog><moderation-rules-dialog></moderation-rules-dialog>';
  } else if (route === 'public/duel') {
    app.innerHTML = '<public-duel></public-duel>';
  } else if (route === 'public/links') {
    app.innerHTML = '<public-links></public-links>';
  } else {
    app.innerHTML = '<public-home></public-home>';
  }
}

render();

window.addEventListener('popstate', render);

document.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="/"]');
  if (!link || link.target === '_blank') return;
  const href = link.getAttribute('href');
  if (!href || href.startsWith('//')) return;
  event.preventDefault();
  history.pushState(null, '', href);
  render();
});
