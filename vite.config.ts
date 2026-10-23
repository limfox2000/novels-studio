import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // 相对路径：站点部署在反向代理子路径下时，构建产物引用 ./assets/... 才能命中
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // 单入口：创作台
      input: {
        studio: fileURLToPath(new URL('./studio.html', import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    watch: {
      // 本地 server.py 的图存档目录，避免自动保存触发 dev 页面整页刷新
      ignored: ['**/graphs/**'],
    },
    proxy: {
      // 本地开发时把 /api 转发到本机 server.py（与远端同款 API）
      '/api': { target: 'http://127.0.0.1:8768', changeOrigin: true },
    },
  },
});
