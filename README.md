# atypica.AI recovery rebuild

This repository is a clean-room reconstruction created from the surviving public website after the original source code was lost.

## Current scope

- Archived public homepage HTML, sitemap, build manifest, screenshots, fonts, images, and styles.
- Rebuilt Next.js public homepage and primary product surfaces.
- Rebuilt pricing controls and sign-in UI with explicit non-transmitting local behavior.
- Added a health endpoint at `/api/health`.

The original private server code, database schema, authentication, payments, and AI orchestration are not present in the public deployment artifacts and must be migrated or reimplemented separately.

## Run locally

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Verification

```bash
pnpm lint
pnpm build
```

Recovery evidence and audit material live under `recovery/` and are intentionally excluded from application linting.
