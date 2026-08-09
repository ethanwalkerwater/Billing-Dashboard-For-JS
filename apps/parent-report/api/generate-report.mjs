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
    response.status(400).send(error instanceof Error ? error.message : String(error));
  }
}
