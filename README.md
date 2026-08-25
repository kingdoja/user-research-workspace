# Cognara AI recovery rebuild

This repository is a clean-room reconstruction created from the surviving public website after the original source code was lost.

## Current scope

- Archived public homepage HTML, sitemap, build manifest, screenshots, fonts, images, and styles.
- Rebuilt Next.js public homepage and primary product surfaces.
- Added local account registration, sign-in, sign-out, opaque database-backed sessions, and personal workspaces.
- Added database-backed study creation, plan confirmation, dynamic research tasks, project lists, and study detail views.
- Added a PostgreSQL-compatible embedded PGlite database for local recovery work, with a documented migration path to Supabase/PostgreSQL.
- Added a durable Plan-and-Execute research harness with typed tools, checkpoints, artifacts, idempotent invocations, a leased job queue, and SSE progress events.
- Added a product-kernel health endpoint at `/api/health`.
- Added `/platform` for governed cross-workspace publishing/delegation and versioned provider cost/quality routing.
- Added `/agent` for Universal Agent conversations, persistent workspace files, immutable Skill bindings, and auditable runs.
- Added governed `atypica.skill/v2` JavaScript/Python packages that execute through the external `atypica.sandbox/v1` runner contract.
- Added a deployable independent Sandbox Runner backed by one-shot Docker/Podman containers with non-root, read-only, default-deny network and resource limits.

The original private server code and data are not present in the public deployment artifacts. AI execution, report generation, payments, file storage, background jobs, email, and production deployment still require provider integrations.

## Run locally

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Production hosts run published images only. Build `deploy/Dockerfile.server` in CI
with `--build-arg ALLOW_PRODUCTION_BUILD=1`, then transfer and restart the image;
do not run `docker build` or `next build` on the production host.

Register a local account at [http://localhost:3000/auth/signup](http://localhost:3000/auth/signup). Local data is stored under `.data/` and is excluded from Git.

The recommended high-quality routing uses DeepSeek V4 Flash for planning and high-volume
research, DeepSeek V4 Pro for audience reasoning and independent report review, and Terra
for report synthesis. Configure `PLAN_PROVIDER`, `RESEARCH_PROVIDER`,
`REASONING_PROVIDER`, `REPORT_PROVIDER`, and `REPORT_JUDGE_PROVIDER`; model overrides are
available through `DEEPSEEK_FAST_MODEL`, `DEEPSEEK_REASONING_MODEL`, `REPORT_MODEL`, and
`REPORT_JUDGE_MODEL`. The report DAG persists the Terra draft and the V4 Pro quality review.
Approved drafts pass through without another model call; rejected drafts receive a targeted
Terra revision constrained to the existing evidence catalog. DeepSeek follow-up turns remain
application-managed and are persisted and replayed from PostgreSQL.

For production, long-running research, or Universal Agent execution, run the worker separately
from the web process:

```bash
pnpm research:worker
```

The web process also wakes one research job after plan confirmation so that flow remains
single-command in local development. Universal Agent requests only enqueue work and require
`pnpm research:worker` to execute it. The database queue is the source of truth; Agent runs
use idempotency keys, one active run per thread, and renewable worker leases.

Production code Skills require the included Runner to be deployed as a separate service. Add
its HTTPS origin to `SKILL_EXECUTOR_ALLOWED_ORIGINS`; the Next.js process only validates and
dispatches the version-locked package, limits, grants, and input, and never evaluates uploaded
code itself.

Sandbox Skills currently run with `networkAccess: false`. A network grant with scoped origins
is rejected before dispatch because a shared Docker/Podman network cannot enforce per-origin
egress for untrusted code. Do not enable networked Sandbox execution until the Runner is placed
behind an operator-controlled egress proxy or equivalent hard network policy.

## Sandbox Runner

Pre-pull the configured JavaScript and Python images, then run the independent service:

```bash
docker pull node:24-alpine
docker pull python:3.13-alpine
SANDBOX_RUNNER_AUTH_TOKEN='replace-with-at-least-24-characters' pnpm sandbox:runner
```

The default listener is `127.0.0.1:8787`. Production must place HTTPS in front of it, use a
dedicated worker host with rootless Podman or another hardened runtime, and pin both runtime
images by digest. The repository includes a systemd user unit, production environment sample,
Caddy TLS proxy and remote deployment gate under `deploy/` and `scripts/`. See
[`services/sandbox-runner/README.md`](services/sandbox-runner/README.md).

The Runner probes its container engine and both configured images before declaring readiness.
Use `/live` for process liveness and `/ready` for traffic admission; `/health` remains a
readiness-compatible endpoint. Prometheus metrics are available at `/metrics` with the
configured metrics token. `SIGTERM`/`SIGINT` stops new admission, drains active executions for
the configured grace period, and then aborts and removes overdue containers. Production
separates metrics access with `SANDBOX_RUNNER_METRICS_AUTH_TOKEN`; the included Prometheus job
uses a Bearer credentials file. Run `pnpm verify:sandbox-worker` on the dedicated Linux host
and `pnpm smoke:sandbox-operations` for the repository-side operations contract.

## Verification

```bash
pnpm lint
pnpm build
pnpm smoke:sandbox-runner
pnpm smoke:sandbox-operations
# Against a deployed HTTPS Runner:
SANDBOX_VERIFY_URL=https://sandbox.example.com SANDBOX_VERIFY_TOKEN=... \
SANDBOX_VERIFY_METRICS_TOKEN=... pnpm verify:sandbox-deployment
pnpm smoke:report-routing
LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated api-access
LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated platform-control
LOCAL_SMOKE_DATABASE_URL=postgresql://...@127.0.0.1:5432/postgres pnpm smoke:isolated universal-agent
DEEPSEEK_PROVIDER_SMOKE_CONFIRM=1 pnpm smoke:deepseek-provider
REPORT_PROVIDER_SMOKE_CONFIRM=1 pnpm smoke:report-provider
```

Recovery evidence and audit material live under `recovery/` and are intentionally excluded from application linting.

## Architecture recovery

The evidence-based architecture audit and staged restoration plan are documented in
[`recovery/ARCHITECTURE_RECOVERY.md`](recovery/ARCHITECTURE_RECOVERY.md). The
`20260813040000_skill_context_foundation.sql` migration adds versioned Skill and
Context storage contracts without changing the existing research harness execution path.
`20260813060000_skill_context_runtime.sql` adds retrieval audit records and pins each
research tool invocation to a built-in Skill version and Context retrieval snapshot.
`20260813070000_runtime_scheduling_experiments.sql` upgrades research execution to a
dependency-ready DAG with leased workspace/provider concurrency, rate windows,
cancellation/timeouts, and stable weighted strategy experiments.
