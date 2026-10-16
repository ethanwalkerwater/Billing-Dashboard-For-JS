import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

// Tauri 四个窗口：main(index) / pill / toast / fab（随时录制悬浮按钮）。
export default defineConfig({
  clearScreen: false,
  server: { strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: { input: { index: page('index.html'), pill: page('pill.html'), toast: page('toast.html'), fab: page('fab.html') } },
  },
});
