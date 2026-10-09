import { defineConfig } from "vite";

// 挂在 CloudBase 静态托管 /birthday/；本地开发把 /birthday-api 代理到线上函数。
export default defineConfig({
  base: "/birthday/",
  server: { host: "0.0.0.0", port: 4179, proxy: { "/birthday-api": { target: "https://app.jsjy.asia", changeOrigin: true } } },
  // three.js 单独成块（scene.ts 动态导入），gzip 后约 135 KB，信封页不等它
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 700 },
});
