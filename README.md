# atypica.AI recovery rebuild

This repository is a clean-room reconstruction created from the surviving public website after the original source code was lost.

## Current scope

- Archived public homepage HTML, sitemap, build manifest, screenshots, fonts, images, and styles.
- Rebuilt Next.js public homepage and primary product surfaces.
- Added local account registration, sign-in, sign-out, opaque database-backed sessions, and personal workspaces.
- Added database-backed study creation, plan confirmation, dynamic research tasks, project lists, and study detail views.
- Added a PostgreSQL-compatible embedded PGlite database for local recovery work, with a documented migration path to Supabase/PostgreSQL.
- Added a durable Plan-and-Execute research harness with typed tools, checkpoints, artifacts, idempotent invocations, a leased job queue, and SSE progress events.
- Added a product-kernel health endpoint at `/api/health`.

The original private server code and data are not present in the public deployment artifacts. AI execution, report generation, payments, file storage, background jobs, email, and production deployment still require provider integrations.

## Run locally

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Register a local account at [http://localhost:3000/auth/signup](http://localhost:3000/auth/signup). Local data is stored under `.data/` and is excluded from Git.

Report follow-up conversations use DeepSeek's Responses-compatible API. Configure
`DEEPSEEK_API_KEY`; the default model is `deepseek-v4-flash`. DeepSeek does not persist
`conversation` or `previous_response_id`, so successful turns are stored in PostgreSQL
and replayed on every follow-up. Provider failures are returned to the client and do not
create synthetic fallback assistant messages.

For production or long-running research, run the worker separately from the web process:

```bash
pnpm research:worker
```

The web process also wakes one queued job after plan confirmation so local development remains single-command. The database queue is the source of truth, so a separate worker can resume queued or expired leased jobs after a process restart.

## Verification

```bash
pnpm lint
pnpm build
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
