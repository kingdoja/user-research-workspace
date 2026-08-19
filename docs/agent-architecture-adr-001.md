# ADR-001: Governed Research Agent Runtime

## Status

Accepted for the next implementation phase.

## Decision

The research product will keep the existing Postgres-backed Harness as the
production execution runtime. The model will act as an Agent Controller that
proposes typed actions through the Responses API. A single Plan Mutation
Service will be the only code path allowed to add dynamic research tasks.

LangGraph is not introduced into the research worker at this stage. It would
duplicate the existing task ledger, leases, retries, checkpoints, waiting-input
recovery, and audit model. It may be used later for isolated workflow
prototypes, but it is not the source of truth for production study runs.

## Boundaries

- Intent, confirmation, report gates, evidence requirements, permissions,
  budgets, retries, leases, checkpoints, cancellation, and audit remain
  deterministic Harness responsibilities.
- The Controller selects a ready task, requests a typed user input, or proposes
  a bounded plan mutation. It cannot write database state directly.
- The Plan Mutation Service validates dependencies, dynamic-task quota, report
  gate placement, Skill versions, and decision linkage before changing the
  ledger.
- Skills are versioned executable contracts. Tools are individual invocations.
  MCP and sandbox executors remain behind capability grants and workspace
  policy.
- Context retrieval is purpose-bound and snapshot-based. Working checkpoint
  state is not promoted to long-term memory automatically.
- Evidence, citations, memory observations, and dynamic-task reasons retain
  source and policy references for replay and evaluation.

## Consequences

This keeps one durable state model and lets the product add model flexibility
without making execution correctness depend on model output. The first rollout
continues to use `shadow` before `active`. The next architectural milestone is
trajectory evaluation and policy-driven task templates, not a framework swap.

## Implementation sequence

1. Unify all dynamic task writes behind the Plan Mutation Service.
2. Make `ask_user` field schemas and selected task keys round-trip through the
   UI and recovery API. Completed: the stored request is the server-side
   validation source of truth for text, URL-list, and choice responses.
3. Link every Agent Controller mutation to `reasoning_decisions` and replay
   snapshots.
4. Add trajectory evaluation for tool choice, evidence gain, policy rejects,
   cost, latency, recovery, and human intervention.
5. Gradually reduce the precompiled DAG to hard gates plus policy-approved
   capability templates.

## Phase 5: Capability Templates

The first versioned template catalog is `research-agent-task-templates-v1`:

- `targeted_research` is bound to `deepResearch`.
- `social_signal_scan` is bound to `scoutSocialTrends` and requires `platform`.

Each template owns an input schema, tool binding, and version. A strategy can
further restrict the catalog with `agentControllerAllowedTemplates`. Both the
Controller and the Harness mutation path validate template existence, policy
allowance, tool matching, and input shape. The selected template and version
are included in reasoning decisions and task mutation events. Legacy provider
actions without a template are normalized by tool name for replay compatibility;
new provider output is instructed to include it explicitly.

## Phase 6: Template-Aware Rollout Gate

Trajectory evaluation now records proposed versus accepted template counts and
computes `templateMatchRate`. Active rollout requires this rate to meet the
configured `agentControllerMinTemplateMatchRate` threshold (default `0.8`),
alongside the existing failure, reject, tool-match, and report-gate checks.
Older evaluations without this metric default to `1` for backward compatibility;
new runs report the metric explicitly.
