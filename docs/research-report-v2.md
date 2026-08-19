# Research Report V2

## Product objective

Research reports are user-facing decision artifacts. Evidence auditing protects the report, but must not become the report's primary narrative.

The V2 pipeline must answer four questions in order:

1. What decision is the user trying to make?
2. Can the selected methods and available evidence answer that question?
3. What conclusions are supported, and what remains directional?
4. What should the user do next?

## Golden output contract

Every report should contain:

1. A direct executive answer to the original brief.
2. Three to six findings written as user-facing conclusions.
3. The business meaning of each finding.
4. Prioritized actions with a concrete execution path.
5. A concise evidence boundary and next-step research plan.
6. Sources and evidence details in an appendix or optional audit view.

The report must not lead with model types, confidence chips, evidence IDs, internal validation language, or workflow telemetry.

## Research question and evidence mapping

| Question type | Typical wording | Required evidence |
| --- | --- | --- |
| Factual | market size, product parameters, policy | official documents, filings, authoritative reports |
| Behavioral | share, save, click, purchase, retention | platform metrics, product analytics, observed behavior |
| Attitudinal | trust, preference, motivation, concern | interviews, surveys, comments, first-person user material |
| Comparative | brand or segment differences | balanced samples using the same dimensions |
| Causal | whether an intervention changes behavior | experiments or quasi-experiments |
| Strategic | what the team should do | synthesis of the relevant evidence above |

Public web research can produce a useful directional analysis, but it cannot be presented as validated behavioral or attitudinal findings when direct evidence is absent.

## Answerability gate

Before report generation, the system classifies the brief and evaluates the evidence packet.

- `decision_ready`: the evidence type matches the research question.
- `directional`: the evidence supports hypotheses and actions, but not validated audience behavior or attitudes.
- `insufficient`: there is not enough usable evidence to produce a responsible analysis.

Directional reports must use titles such as `公开资料方向性分析` or `策略假设与验证方案`. They may still provide concrete recommendations, but must not present inferred preferences as observed facts.

## Source quality gate

Sources are rejected before synthesis when they are maintenance pages, access-error pages, template-placeholder shells, empty pages, or clearly unrelated to the brief.

Accepted sources are ranked using:

- research entity coverage;
- research dimension coverage;
- platform or behavioral signal coverage;
- source independence and authority;
- promotional-risk and category-mismatch penalties.

Success is based on research-question coverage, not a raw source count.

## Analysis pipeline

```text
Brief
-> research question classification
-> evidence feasibility
-> source plan and sampling
-> source quality filtering
-> evidence units and coding
-> theme and comparison synthesis
-> conclusions and actions
-> factual review
-> reader-value review
-> user report + evidence audit
```

## Dual quality review

The factual review checks citations, source type, counterevidence, synthetic evidence boundaries, and claim support.

The reader-value review checks:

- whether the original brief is answered;
- whether the evidence type matches the question;
- whether conclusions add information beyond generic advice;
- whether recommendations are specific and executable;
- whether internal audit language has leaked into the user narrative.

A report cannot be approved when it claims platform scanning without platform evidence, presents behavioral preferences without behavioral evidence, or leaves the main brief unanswered.

## User report and audit separation

The default report view shows conclusions, evidence basis in plain language, implications, actions, limitations, and sources.

The optional audit view shows claim type, confidence, evidence references, source excerpts, and support status. A reference attached to an inference is contextual support, not direct evidence.

## Golden design for the Ninebot and Yadea case

The brief asks what target audiences share, save, and trust, and why. With public web evidence only, the correct output is:

`九号与雅迪内容策略：公开资料方向性分析与验证方案`

The report should:

- separate sharing, saving, and trust mechanisms;
- compare the brands only where samples are balanced;
- identify content hypotheses such as reproducible range tests, scenario demonstrations, transparent trade-offs, and decision tools;
- label these as directional until platform metrics, comments, interviews, or experiments validate them;
- provide a concrete platform sampling and A/B testing plan.

## Delivery phases

### Phase 1: product and quality correction

- answerability gate;
- source quality filtering;
- context relevance threshold;
- user report and audit separation;
- expanded quality-review rubric;
- regression tests.

### Phase 2: native research evidence

- authorized platform connectors or imports;
- post-level engagement metrics;
- comment and user-language coding;
- balanced brand, platform, format, and time-window sampling.

### Phase 3: research operations

- golden brief/report evaluation set;
- report usefulness scoring;
- experiment design and result ingestion;
- longitudinal quality monitoring.
