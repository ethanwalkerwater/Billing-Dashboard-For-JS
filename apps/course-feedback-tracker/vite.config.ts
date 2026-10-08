import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // 部署在静态托管的 /feedback/ 子目录（https://app.jsjy.asia/feedback/），和 /ielts/、/income/ 并列；
  // 根目录 / 只放一个跳转页（root-redirect/index.html），兼容旧链接。
  base: "/feedback/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "0.0.0.0",
    port: 4176,
    allowedHosts: ["terminal.local", "localhost", "127.0.0.1"],
  },
  build: { outDir: "dist", emptyOutDir: true },
});
