import { defineConfig } from "vite";

import { generateStudentBillingPdfBuffer } from "./api/generate-student-billing-pdf.mjs";

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function localPdfApi() {
  return {
    name: "local-parent-report-pdf-api",
    configureServer(server) {
      server.middlewares.use("/api/generate-report", async (request, response) => {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("仅支持 POST 请求");
          return;
        }
        try {
          const buffer = await generateStudentBillingPdfBuffer(await readJsonBody(request));
          response.statusCode = 200;
          response.setHeader("content-type", "application/pdf");
          response.setHeader("cache-control", "private, no-store");
          response.end(buffer);
        } catch (error) {
          console.error(error);
          response.statusCode = 400;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end(error instanceof Error ? error.message : String(error));
        }
      });
    },
  };
}

export default defineConfig({
  root: "web",
  // 师资库管理界面需要展示内置老师头像；优化后的小图（约 250KB）作为静态资源
  // 在 dev 下由 vite 直接服务，build 时拷贝到 dist 根目录，与 builtinPhotoUrl 对应。
  publicDir: "../assets/teacher-optimized",
  plugins: [localPdfApi()],
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local", "localhost", "127.0.0.1"],
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
