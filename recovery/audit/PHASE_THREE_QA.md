# Phase three QA

## Provider integration

The reconstruction now supports a server-side OpenAI provider without exposing credentials to the browser.

- Study planning uses the Responses API with strict structured output.
- Planning falls back to deterministic local rules when the provider is unavailable or planning fails.
- Confirmed studies execute public-web research with the hosted `web_search` tool.
- Research output is validated against a strict report schema before persistence.
- Reports retain structured JSON, sanitized compatibility HTML, URL citations, model and response identifiers, prompt versions, usage, and audit events.
- Run claiming is atomic, completed runs are not duplicated, and failed runs can be retried.
- Provider status is visible through `/api/health` without exposing secrets.

The default planning and research model is `gpt-5.6-terra`. Both stages can be overridden independently with `OPENAI_PLAN_MODEL` and `OPENAI_RESEARCH_MODEL`.

## Functional verification

- `pnpm lint`: passed
- `pnpm build`: passed
- No-key isolated production flow: passed
- Registration, local fallback plan creation, confirmation, and recoverable provider-waiting state: passed
- Missing-key run request returned HTTP 503 without corrupting study state: passed
- Mock Responses API model-backed planning: passed
- Mock hosted-research completion with structured report persistence: passed
- Invalid mock report entered the failed state and was recoverable through retry: passed
- Retried valid report completed with two persisted URL citations: passed
- Repeated execution request returned the completed state without creating duplicate work: passed
- Browser QA at 1280px, 1440x1000, and 390x844: passed
- Mobile horizontal overflow: none
- Browser console warnings and errors during the tested workflow: none

Temporary QA screenshots were saved outside the repository:

- `/tmp/atypica-provider-waiting-desktop.png`
- `/tmp/atypica-provider-waiting-mobile.png`
- `/tmp/atypica-provider-report-desktop.png`
- `/tmp/atypica-provider-report-mobile.png`

## Remaining production limits

A real paid OpenAI request was not run because this workspace does not contain an `OPENAI_API_KEY`. The mock integration exercised the same SDK request and response path through `OPENAI_BASE_URL`, but it is not evidence of account access, model entitlement, quota, billing, or live web-search availability.

The current Next.js `after()` execution path is suitable for local reconstruction and bounded validation. Production long-running research should move to a durable queue and worker with retries, leases, timeouts, idempotency, and operational monitoring.
