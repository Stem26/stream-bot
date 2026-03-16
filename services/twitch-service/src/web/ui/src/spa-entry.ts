import './public-base.scss';
import './styles.scss';
import './components/public/public-home/public-home';
import './components/public/public-duel/public-duel';
import './components/public/public-links/public-links';

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
    app.innerHTML = '<div class="admin-loading">Загрузка…</div>';
    import('./admin-route').then(() => {
      app.innerHTML = '<admin-panel></admin-panel><command-dialog></command-dialog><link-dialog></link-dialog><counter-dialog></counter-dialog><party-dialog></party-dialog><moderation-rules-dialog></moderation-rules-dialog><link-whitelist-dialog></link-whitelist-dialog>';
    });
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
  // Переход в админку — только полная загрузка, чтобы nginx запросил пароль до отдачи страницы
  const path = href.split('#')[0].replace(/\/$/, '') || '/';
  if (path === '/admin' || path.startsWith('/admin/')) {
    window.location.href = href;
    return;
  }
  event.preventDefault();
  history.pushState(null, '', href);
  render();
});
