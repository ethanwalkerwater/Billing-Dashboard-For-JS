import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 取消课程管理页：部署到静态托管 /cancellations/（https://app.jsjy.asia/cancellations/）
export default defineConfig({
  base: "/cancellations/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist-cancellations",
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("./cancellations.html", import.meta.url)) },
  },
});
