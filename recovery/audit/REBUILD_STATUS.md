# Rebuild status

## Completed

- Public homepage visual and DOM snapshot
- Core route visual snapshots
- Next.js build and sitemap evidence
- Public images, fonts, and stylesheet archive
- Fresh Next.js TypeScript application
- Homepage, technology, pricing, Persona, Interview, Sage, sign-in, and health endpoint
- Local account registration, sign-in, sign-out, and persistent sessions
- Multi-tenant workspace schema with indexed foreign keys
- Persistent study creation, project listing, deterministic plan drafting, and plan confirmation
- OpenAI-backed structured plan generation with a deterministic local fallback
- Public-web research execution through the Responses API hosted web search tool
- Durable Plan-and-Execute research harness with typed tools, persisted dynamic tasks, checkpoints, artifacts, and idempotent tool invocations
- PostgreSQL-backed job queue with worker leases, retry scheduling, lease renewal, and a standalone research worker
- Authenticated SSE progress delivery with event cursors and automatic reconnect
- AI-synthesized Personas, Panels, simulated interviews, direction validation, and final report materialization
- Structured reports with findings, recommendations, limitations, citations, and provider audit metadata
- Recoverable provider-waiting, queued, running, failed, retry, and completed execution states
- Conversation-oriented study detail view with live task-level execution traces and legacy nine-step replay compatibility
- Desktop and 390px mobile visual QA with stable menu and no horizontal overflow

## Intentionally not restored yet

- Production identity provider, password reset, email verification, and account switching
- Real participant recruitment/interviews, podcasts, and production team data
- Stripe or AWS Marketplace billing
- Admin, team, API-key, and domain-verification workflows
- Object storage, email delivery, and production worker deployment/observability

## Next migration order

1. Provision Supabase/PostgreSQL and migrate the PGlite schema without changing public IDs.
2. Connect production authentication and map external auth UUIDs to existing local users.
3. Deploy and monitor the existing durable research worker separately from the web process.
4. Add object storage and email delivery for report exports and long-running job notifications.
5. Add real participant recruitment and moderated interview operations alongside the existing synthetic research tools.
6. Add billing only after identity, token accounting, and entitlement rules are stable.
