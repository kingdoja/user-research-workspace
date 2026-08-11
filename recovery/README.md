# Recovery record

## Evidence captured

- `reference/site/`: surviving homepage HTML, sitemap, robots file, web app manifest, and Next.js build manifest.
- `reference/assets/`: browser-observed public images, fonts, stylesheets, and inline SVG exports.
- `reference/screenshots/`: live desktop references for the homepage, pricing, technology, Persona, Interview, Sage, and sign-in surfaces.
- `audit/core-route-snapshots.json`: titles, headings, actions, redirects, and visible controls collected from the live site.

The live build identified during recovery used Next.js build ID `I5qGWqKFydGRARqiRwKAG`. Public source maps returned HTTP 404, so the original TypeScript and server source could not be restored from the deployment.

## Privacy boundary

The sitemap contained 492 URLs, including many public report-share URLs. Those report contents were not bulk-copied into the repository because they are user-generated data, not application source code.

## Rebuild boundary

Public assets and visible behavior are reconstruction references. Authentication, billing, private APIs, prompts, orchestration logic, and database behavior require separate implementation against authorized infrastructure and data snapshots.

## Refresh the archive

Run `pnpm archive:public` to refresh the controlled public-page archive under `reference/refresh/`. The script deliberately excludes report, study, podcast, and other user-generated share URLs.
