import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 完整报告网页 + 后台：静态托管到 https://app.jsjy.asia/classroom/report.html 和 /classroom/admin/，数据走同域 /classroom-api
// admin.html 是旧地址，只做跳转
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist-report',
    emptyOutDir: true,
    rollupOptions: { input: { report: fileURLToPath(new URL('report.html', import.meta.url)), admin: fileURLToPath(new URL('admin/index.html', import.meta.url)), adminOld: fileURLToPath(new URL('admin.html', import.meta.url)) } },
  },
});
