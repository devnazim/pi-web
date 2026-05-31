import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const apiPort = Number(process.env.PI_WEB_PORT ?? 43110);

export default defineConfig({
  root: 'web',
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
      '/ws': {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
