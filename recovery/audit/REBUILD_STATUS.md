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
- Conversation-oriented study detail view and provider-waiting execution state
- Desktop and 390px mobile visual QA with stable menu and no horizontal overflow

## Intentionally not restored yet

- Production identity provider, password reset, email verification, and account switching
- Provider-backed study execution, personas, interviews, reports, podcasts, and team data
- Stripe or AWS Marketplace billing
- AI agent execution and model-provider integrations
- Admin, team, API-key, and domain-verification workflows

## Next migration order

1. Provision Supabase/PostgreSQL and migrate the PGlite schema without changing public IDs.
2. Connect production authentication and map external auth UUIDs to existing local users.
3. Add OpenAI-backed planning and research execution with versioned prompts and audit events.
4. Implement reports, Panels, Personas, and interview projects on the existing workspace boundary.
5. Add object storage, background jobs, and email before enabling long-running research.
6. Add billing only after identity, token accounting, and entitlement rules are stable.
