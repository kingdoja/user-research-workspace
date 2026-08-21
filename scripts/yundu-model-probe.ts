import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || "https://yundu.lat/v1").replace(/\/$/, "");
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error("OPENAI_API_KEY_MISSING");

const timeoutMs = Math.max(5_000, Math.min(60_000, Number(process.env.YUNDU_PROBE_TIMEOUT_MS ?? 30_000)));
const candidates = (process.env.YUNDU_PROBE_MODELS?.split(",") ?? ["sol", "sol-3.0", "sol-3", "gpt-5.6-terra", "gpt-4o-mini"])
  .map((model) => model.trim())
  .filter(Boolean);
const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

async function probe(model: string) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 4,
        temperature: 0,
      }),
    });
    const body = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* metadata-only probe */ }
    const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : {};
    return {
      model,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      result: response.ok && Array.isArray(parsed.choices) ? "valid_response" : "http_error",
      errorCode: typeof error.code === "string" ? error.code : typeof parsed.code === "string" ? parsed.code : null,
      responseModel: typeof parsed.model === "string" ? parsed.model : null,
    };
  } catch (error) {
    return {
      model,
      status: null,
      latencyMs: Date.now() - startedAt,
      result: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
      errorCode: null,
      responseModel: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const modelsStartedAt = Date.now();
  let models: string[] | null = null;
  let modelsStatus: number | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
      modelsStatus = response.status;
      const body = await response.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null;
      models = Array.isArray(body?.data) ? body.data.flatMap((item) => typeof item.id === "string" ? [item.id] : []) : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    modelsStatus = null;
  }
  const results = await Promise.all(candidates.map(probe));
  console.log(JSON.stringify({
    endpoint: baseUrl,
    modelsEndpoint: { status: modelsStatus, latencyMs: Date.now() - modelsStartedAt, modelCount: models?.length ?? null, candidates: models ? candidates.map((model) => ({ model, listed: models!.includes(model) })) : null },
    probes: results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
