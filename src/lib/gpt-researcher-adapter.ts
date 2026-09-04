import { assertPublicSourceUrl, canonicalizeSourceUrl } from "@/lib/source-connectors";
import type { PublicWebSearchMetadata, PublicWebSource } from "@/lib/public-web-search";
import { normalizeGptResearcherReportType, type GptResearcherReportType } from "@/lib/gpt-researcher-types";

export { GPT_RESEARCHER_REPORT_TYPES, GPT_RESEARCHER_REPORT_TYPE_LABELS, isGptResearcherReportType, normalizeGptResearcherReportType } from "@/lib/gpt-researcher-types";
export type { GptResearcherReportType } from "@/lib/gpt-researcher-types";

export type GptResearcherProgress = { type: string; payload?: Record<string, unknown> };

export type GptResearcherRunResult = {
  queries: string[];
  sources: PublicWebSource[];
  metadata: PublicWebSearchMetadata;
  responseId: string;
  model: string;
  usage: unknown;
  draftReport?: string;
};

export function isGptResearcherEnabled() {
  return process.env.RESEARCH_ENGINE?.trim().toLowerCase() === "gpt-researcher";
}

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function getGptResearcherRuntimeLimits() {
  return {
    taskTimeoutSeconds: boundedIntegerEnv("GPT_RESEARCHER_TASK_TIMEOUT_SECONDS", 900, 60, 3600),
    bridgeRunTimeoutSeconds: boundedIntegerEnv("GPT_RESEARCHER_BRIDGE_RUN_TIMEOUT_SECONDS", 720, 30, 1800),
    idleTimeoutSeconds: boundedIntegerEnv("GPT_RESEARCHER_IDLE_TIMEOUT_SECONDS", 120, 15, 600),
  };
}

function bridgeConfig() {
  const baseUrl = process.env.GPT_RESEARCHER_URL?.trim() || "http://127.0.0.1:8000";
  const token = process.env.GPT_RESEARCHER_BRIDGE_TOKEN?.trim();
  if (!token) throw new Error("GPT_RESEARCHER_BRIDGE_TOKEN_MISSING");
  return { baseUrl: baseUrl.replace(/\/$/u, ""), token };
}

function parseSseBlock(block: string) {
  const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!data || data === "{}") return null;
  try { return JSON.parse(data) as { type?: string; payload?: Record<string, unknown>; output?: string }; } catch { return null; }
}

async function validateSeedUrls(values: string[] | undefined) {
  const validated = new Map<string, string>();
  for (const value of values ?? []) {
    const url = await assertPublicSourceUrl(value);
    const canonical = canonicalizeSourceUrl(url.toString());
    if (!validated.has(canonical)) validated.set(canonical, canonical);
  }
  return [...validated.values()].slice(0, 8);
}

export async function runGptResearcher(input: {
  brief: string;
  framework: string;
  userPublicId: string;
  studyPublicId: string;
  signal?: AbortSignal;
  additionalSeedUrls?: string[];
  reportType?: GptResearcherReportType;
  onProgress?: (event: GptResearcherProgress) => Promise<void> | void;
}): Promise<GptResearcherRunResult> {
  const { baseUrl, token } = bridgeConfig();
  const validatedSeedUrls = await validateSeedUrls(input.additionalSeedUrls);
  const limits = getGptResearcherRuntimeLimits();
  const bridgeController = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, bridgeController.signal])
    : bridgeController.signal;
  let abortCode: "GPT_RESEARCHER_BRIDGE_RUN_TIMEOUT" | "GPT_RESEARCHER_IDLE_TIMEOUT" | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let createdRunId: string | null = null;
  let cancellationRequested = false;
  const totalTimer = setTimeout(() => {
    abortCode = "GPT_RESEARCHER_BRIDGE_RUN_TIMEOUT";
    bridgeController.abort(new DOMException(abortCode, "AbortError"));
  }, limits.bridgeRunTimeoutSeconds * 1000);
  const markActivity = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortCode = "GPT_RESEARCHER_IDLE_TIMEOUT";
      bridgeController.abort(new DOMException(abortCode, "AbortError"));
    }, limits.idleTimeoutSeconds * 1000);
  };
  const cancelExternalRun = () => {
    if (!createdRunId || cancellationRequested) return;
    cancellationRequested = true;
    void fetch(`${baseUrl}/v1/research/runs/${createdRunId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelExternalRun, { once: true });
  markActivity();

  try {
    const createResponse = await fetch(`${baseUrl}/v1/research/runs`, {
      method: "POST", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `${input.brief}\n研究框架：${input.framework}`,
        report_type: normalizeGptResearcherReportType(input.reportType), report_source: "web", source_urls: validatedSeedUrls,
        metadata: { userPublicId: input.userPublicId, studyPublicId: input.studyPublicId },
      }),
    });
    if (!createResponse.ok) throw new Error(`GPT_RESEARCHER_BRIDGE_CREATE_${createResponse.status}`);
    const created = await createResponse.json() as { run_id?: string; events_url?: string };
    if (!created.run_id) throw new Error("GPT_RESEARCHER_BRIDGE_RUN_ID_MISSING");
    createdRunId = created.run_id;
    markActivity();

    let draftReport = "";
    const eventResponse = await fetch(`${baseUrl}${created.events_url || `/v1/research/runs/${created.run_id}/events`}`, {
      signal, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    });
    if (!eventResponse.ok || !eventResponse.body) throw new Error(`GPT_RESEARCHER_BRIDGE_EVENTS_${eventResponse.status}`);
    const reader = eventResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/u);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const event = parseSseBlock(block);
          if (!event) continue;
          markActivity();
          const payload = event.payload ?? {};
          const output = typeof event.output === "string" ? event.output : typeof payload.output === "string" ? payload.output : "";
          if (event.type === "report" && output) draftReport += output;
          await input.onProgress?.({ type: `gpt_researcher.${event.type || "progress"}`, payload: { ...payload, output: output || undefined } });
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const resultResponse = await fetch(`${baseUrl}/v1/research/runs/${created.run_id}`, { signal, headers: { authorization: `Bearer ${token}` } });
    if (!resultResponse.ok) throw new Error(`GPT_RESEARCHER_BRIDGE_RESULT_${resultResponse.status}`);
    const result = await resultResponse.json() as { status: string; report?: string; draft?: string; sources?: PublicWebSource[]; error?: string | null };
    if (result.status !== "completed") throw new Error(result.error || `GPT_RESEARCHER_BRIDGE_${result.status.toUpperCase()}`);
    const sources = (result.sources ?? []).filter((source) => typeof source?.url === "string" && /^https?:\/\//u.test(source.url));
    if (!sources.length) throw new Error("PUBLIC_WEB_SOURCES_INSUFFICIENT");
    return {
      queries: [input.brief], sources,
      metadata: { primaryProvider: "gpt-researcher", fallbackUsed: false, seedSourceCount: input.additionalSeedUrls?.length ?? 0, searchSourceCount: sources.length, finalSourceCount: sources.length, connectorRunPublicId: created.run_id, policyVersion: "gpt-researcher-bridge-v1" },
      responseId: created.run_id, model: "gpt-researcher", usage: null,
      draftReport: result.report || result.draft || draftReport || undefined,
    };
  } catch (error) {
    cancelExternalRun();
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    if (abortCode) throw new Error(abortCode);
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    signal.removeEventListener("abort", cancelExternalRun);
  }
}
