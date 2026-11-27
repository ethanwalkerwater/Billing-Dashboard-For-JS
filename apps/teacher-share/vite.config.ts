import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 和其他模块共用同一个 CloudBase 静态托管，本站挂在 /share/ 子目录下。
export default defineConfig({
  base: "/share/",
  plugins: [react()],
  server: { host: "0.0.0.0", port: 4189 },
  build: { outDir: "dist", emptyOutDir: true },
});
