import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** ブラウザだけで動くデモ（モックバックエンド内蔵）。相対パスで出力して静的ホスティングできるようにする */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
    rollupOptions: { input: 'demo.html' },
  },
});
