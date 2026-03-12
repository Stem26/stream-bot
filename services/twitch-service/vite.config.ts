import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'src/web/ui'),
  base: './',
  build: {
    // В проде express ищет index.html относительно dist/src/web/public,
    // поэтому складываем билд прямо туда
    outDir: resolve(__dirname, 'dist/src/web/public'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});

