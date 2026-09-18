import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 和反馈追踪系统共用同一个 CloudBase 静态托管，本站挂在 /income/ 子目录下。
export default defineConfig({
  base: "/income/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "0.0.0.0", port: 4177 },
  build: { outDir: "dist", emptyOutDir: true },
});
