import { generateStudentBillingPdfBuffer } from "./generate-student-billing-pdf.mjs";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    response.status(405).send("仅支持 POST 请求");
    return;
  }

  try {
    const body = typeof request.body === "string"
      ? JSON.parse(request.body)
      : request.body;
    const buffer = await generateStudentBillingPdfBuffer(body || {});
    const safeName = String(body?.report?.studentName || "学生")
      .replace(/[\\/:*?"<>|]/g, "");
    const month = String(body?.report?.month || "课时费明细");
    const asciiName = `parent-billing-${month}.pdf`;
    response.setHeader("content-type", "application/pdf");
    response.setHeader(
      "content-disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`${safeName}-${month}.pdf`)}`,
    );
    response.setHeader("cache-control", "private, no-store");
    response.status(200).send(buffer);
  } catch (error) {
    console.error(error);
    const statusCode = Number(error?.statusCode);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
      ? statusCode
      : 500;
    const message = status >= 500
      ? "PDF 生成服务暂时不可用，请稍后重试"
      : error instanceof Error ? error.message : String(error);
    response.status(status).send(message);
  }
}
