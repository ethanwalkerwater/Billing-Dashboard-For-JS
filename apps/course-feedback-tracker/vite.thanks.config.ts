import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appDir = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root: appDir + "src/thanks-admin",
  envDir: appDir,
  base: "/feedback_thanks/",
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": appDir + "src" } },
  build: { outDir: appDir + "dist-thanks", emptyOutDir: true },
});
