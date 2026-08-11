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
- Structured reports with findings, recommendations, limitations, citations, and provider audit metadata
- Recoverable provider-waiting, queued, running, failed, retry, and completed execution states
- Conversation-oriented study detail view with automatic execution-state refresh
- Desktop and 390px mobile visual QA with stable menu and no horizontal overflow

## Intentionally not restored yet

- Production identity provider, password reset, email verification, and account switching
- Persona simulation, real interviews, podcasts, Panels, and production team data
- Stripe or AWS Marketplace billing
- Admin, team, API-key, and domain-verification workflows
- Durable production job workers, queues, object storage, and email delivery

## Next migration order

1. Provision Supabase/PostgreSQL and migrate the PGlite schema without changing public IDs.
2. Connect production authentication and map external auth UUIDs to existing local users.
3. Move request-bound research execution to a durable job queue and worker before production use.
4. Add object storage and email delivery for report exports and long-running job notifications.
5. Implement Panels, Personas, and interview projects on the existing workspace boundary.
6. Add billing only after identity, token accounting, and entitlement rules are stable.
