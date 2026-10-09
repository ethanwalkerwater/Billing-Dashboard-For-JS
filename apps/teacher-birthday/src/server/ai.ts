/** OpenAI 兼容 chat/completions。未配置时直接抛错，由调用方回退模板。 */
export function createGenerate(env: { baseUrl?: string; apiKey?: string; model?: string }) {
  return async (messages: Array<{ role: string; content: string }>): Promise<string> => {
    if (!env.baseUrl || !env.apiKey || !env.model) throw new Error("AI 未配置");
    const response = await fetch(`${env.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: env.model, messages, temperature: 0.9, max_tokens: 400 }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; code?: string; message?: string };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!response.ok || !text) throw new Error(`AI 调用失败：${body.code ?? response.status} ${body.message ?? ""}`);
    return text;
  };
}
