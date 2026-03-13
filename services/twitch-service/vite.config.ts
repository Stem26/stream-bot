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
        'admin': resolve(__dirname, 'src/web/ui/admin.html'),
        'public-home': resolve(__dirname, 'src/web/ui/public-home.html'),
        'public-duel': resolve(__dirname, 'src/web/ui/public-duel.html'),
        'public-links': resolve(__dirname, 'src/web/ui/public-links.html'),
      },
    },
  },
  server: {
    port: 5173,
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
          } else if (req.url === '/public') {
            req.url = '/public-home.html';
          } else if (req.url === '/public/duel') {
            req.url = '/public-duel.html';
          } else if (req.url === '/public/links') {
            req.url = '/public-links.html';
          } else if (req.url === '/admin') {
            req.url = '/admin.html';
          }
          next();
        });
      },
    },
  ],
});

