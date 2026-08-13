# Phase two QA

## Authenticated workflow evidence

The signed-in product was inspected read-only. No study, upload, API key, invitation, purchase, podcast, or Token-consuming action was triggered during reference research.

Observed product flow:

1. User submits a behavioral or decision-making business question.
2. The system asks clarification questions and creates a Plan Mode draft.
3. The user confirms and locks the research plan.
4. Execution appends tool events and todo progress to the conversation.
5. The completed study exposes a report, Panel, Personas, follow-up research, and optional podcast.

The local reconstruction now implements steps 1-5 for public-web research and explicitly labeled AI-synthetic participants. Tool calls, dynamic tasks, artifacts, checkpoints, queue state, and progress events are persisted. It does not represent simulated Persona interviews as real recruited-participant evidence.

## Fidelity ledger

| Area | Concept/live evidence | Implemented result | Resolution |
| --- | --- | --- | --- |
| App skeleton | Fixed sidebar, top account bar, primary work area, right progress rail | Same four-part operational layout | Matched |
| Primary workflow | Live `/newstudy` is question-first and conversation-driven | Brief composer creates a saved plan, then redirects to a conversation detail route | Live behavior intentionally overrides the concept's always-visible plan rows |
| Typography | Euclid-like compact UI typography with restrained headings | Existing Euclid Circular asset retained; control and table sizes explicitly defined | Matched |
| Palette | Near-black surfaces, gray dividers, acid-green state accent | `#111213` shell, restrained surfaces, `#65ff43` accent | Matched |
| Container model | Open operational regions, rows, rails, few shallow panels | No page-section card nesting; cards only frame composer, plan, settings summaries, and repeated scenarios | Matched |
| Responsive behavior | Mobile requires compact header and navigable product rail | 390px layout stacks the progress rail, tables scroll internally, sidebar opens to a measured 250px | Verified |

Above-the-fold copy intentionally follows the authenticated live workflow rather than the generated concept. Fake recent studies, fake active executions, and fake completion metrics were removed.

## Functional verification

- `pnpm lint`: passed
- `pnpm build`: passed with clean output
- `pnpm exec tsc --noEmit --pretty false`: passed
- Durable research schema rollback smoke test: five tables present and task, invocation, artifact, checkpoint, and queue writes passed
- `pnpm research:worker:once`: passed and exited cleanly with an empty queue
- Isolated production server and temporary PGlite directory: passed
- Register account and receive session cookie: passed
- Create study and load detail route: passed
- Confirm and lock plan: passed
- Sign out, sign in again, and retrieve the same study: passed
- Desktop viewport: 1440x1000
- Mobile viewport: 390x844
- Mobile horizontal overflow: none
- Browser console and page errors during the tested workflow: none

Local visual QA used bundled Playwright with the installed Chrome binary after the authenticated in-app browser research tab had been finalized. Screenshots:

- `reference/screenshots/workspace-rebuild-desktop.png`
- `reference/screenshots/study-rebuild-desktop.png`
- `reference/screenshots/workspace-rebuild-mobile.png`
- `reference/screenshots/workspace-rebuild-mobile-menu.png`
