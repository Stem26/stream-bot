import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'src/web/ui'),
  base: '/',
  build: {
    outDir: resolve(__dirname, 'dist/src/web/public'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/web/ui/index.html'),
        'twitch-oauth': resolve(__dirname, 'src/web/ui/twitch-oauth.html'),
      },
    },
  },
  server: {
    port: 5173,
    open: '/public',
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    {
      name: 'rewrite-middleware',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/') {
            res.writeHead(302, { Location: '/public' });
            res.end();
            return;
          }
          if (req.url?.startsWith('/oauth')) {
            req.url = '/twitch-oauth.html';
            return next();
          }
          if (req.url === '/public' || req.url === '/public/' || req.url === '/public/duel' || req.url === '/public/links' || req.url === '/admin') {
            req.url = '/index.html';
            return next();
          }
          next();
        });
      },
    },
  ],
});
