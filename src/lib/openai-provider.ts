import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";
import { z } from "zod";
import type { StudyMethod } from "@/lib/research-types";
import { getDatabase } from "@/lib/db";
import {
  collectPublicWebSources,
  type PublicWebSearchMetadata,
  type PublicWebSource,
} from "@/lib/public-web-search";
import {
  cleanupPreparedSourceRawStorage,
  materializeSourceConnectorAudit,
  prepareSourceConnectorAuditRawStorage,
  summarizeSourceConnectorAudit,
  type PreparedSourceConnectorAudit,
  type SourceConnectorAuditSummary,
} from "@/lib/source-connectors";
import {
  collectBlueskyPublicSources,
  getBlueskyPublicConnectorStatus,
} from "@/lib/bluesky-social-connector";
import { buildReportEvidenceCatalog, formatReportEvidenceCatalog } from "@/lib/report-evidence";

const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEFAULT_DEEPSEEK_REASONING_MODEL = "deepseek-v4-pro";
const PLAN_PROMPT_VERSION = "study-plan-v1";
const CLARIFICATION_PROMPT_VERSION = "study-clarification-v1";
export const REPORT_PROMPT_VERSION = "synthetic-panel-research-v2-evidence-graph";
export const REPORT_JUDGE_PROMPT_VERSION = "research-report-judge-v1";
export const REPORT_REVISION_PROMPT_VERSION = "research-report-revision-v1";
const FOLLOWUP_PROMPT_VERSION = "report-followup-v3";
const INTERVIEW_PROMPT_VERSION = "synthetic-interview-v1";
export const REALTIME_INTERVIEW_PROMPT_VERSION = "realtime-interview-v1";
const HARNESS_INTERVIEW_PROMPT_VERSION = "research-harness-interview-v2";
const AUDIENCE_CALL_PROMPT_VERSION = "research-harness-audience-call-v2";
const DISCUSSION_PROMPT_VERSION = "research-harness-discussion-v2";
export const UNIVERSAL_AGENT_PROMPT_VERSION = "universal-agent-v1";

const universalAgentTurnSchema = z.object({
  decisionSummary: z.string().min(2).max(600),
  action: z.enum(["list_files", "read_file", "write_file", "execute_skill", "finish"]),
  message: z.string().max(12_000),
  path: z.string().max(240).nullable(),
  content: z.string().max(120_000).nullable(),
  skillPublicId: z.string().max(160).nullable(),
  argumentsJson: z.string().max(32_000).nullable(),
});

const universalAgentTurnJsonSchema = {
  type: "object",
  properties: {
    decisionSummary: { type: "string", minLength: 2, maxLength: 600 },
    action: { type: "string", enum: ["list_files", "read_file", "write_file", "execute_skill", "finish"] },
    message: { type: "string", maxLength: 12_000 },
    path: { type: ["string", "null"], maxLength: 240 },
    content: { type: ["string", "null"], maxLength: 120_000 },
    skillPublicId: { type: ["string", "null"], maxLength: 160 },
    argumentsJson: { type: ["string", "null"], maxLength: 32_000 },
  },
  required: ["decisionSummary", "action", "message", "path", "content", "skillPublicId", "argumentsJson"],
  additionalProperties: false,
} as const;

const searchSourcePlanSchema = z.object({
  queries: z.array(z.string().min(3)).min(3),
  seedUrls: z.array(z.string().min(10)).min(4),
});

const searchSourcePlanJsonSchema = {
  type: "object",
  properties: {
    queries: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", minLength: 3, maxLength: 120 },
    },
    seedUrls: {
      type: "array",
      minItems: 4,
      maxItems: 16,
      items: { type: "string", minLength: 10, maxLength: 500 },
    },
  },
  required: ["queries", "seedUrls"],
  additionalProperties: false,
} as const;

const planSchema = z.object({
  studyType: z.enum(["user_research", "fast_insight", "product_rnd", "panel_only"]),
  framework: z.string().min(2),
  methods: z.array(z.enum(["Interview Chat", "Discussion Chat", "Scout Agent", "Fast Insight"])),
  personaFilters: z.object({
    audience: z.string().min(2),
    source: z.string().min(2),
  }),
  personaCount: z.number().int().min(1).max(20),
  estimatedDurationMinutes: z.number().int().min(30).max(4320),
  estimatedTokens: z.number().int().min(10000).max(250000),
  rationale: z.string().min(20),
});

const clarificationOptionSetSchema = z.object({
  question: z.string().min(6).max(120),
  options: z.array(z.string().min(2).max(80)).length(4),
});

const clarificationSchema = z.object({
  businessGoal: clarificationOptionSetSchema,
  researchFocus: clarificationOptionSetSchema,
  targetAudience: clarificationOptionSetSchema,
  researchScope: clarificationOptionSetSchema,
});

const reportSchema = z.object({
  title: z.string().min(4),
  executiveSummary: z.string().min(80),
  findings: z.array(z.object({
    title: z.string().min(2),
    insight: z.string().min(40),
    evidence: z.string().min(30),
    implication: z.string().min(30),
    claimType: z.enum(["fact", "human_observation", "synthetic_simulation", "model_inference"]),
    confidence: z.enum(["low", "medium", "high"]),
    evidenceRefs: z.array(z.string().regex(/^(web|synthetic|discussion)-\d{2}$/)).max(8),
  })).min(3),
  recommendations: z.array(z.object({
    title: z.string().min(2),
    action: z.string().min(30),
    rationale: z.string().min(20),
    priority: z.enum(["high", "medium", "low"]),
  })).min(3),
  limitations: z.array(z.string().min(10)).min(1),
  nextQuestions: z.array(z.string().min(10)).min(2),
});

const reportQualityReviewSchema = z.object({
  verdict: z.enum(["approved", "revise"]),
  score: z.number().int().min(0).max(100),
  summary: z.string().min(20).max(1200),
  issues: z.array(z.object({
    severity: z.enum(["high", "medium", "low"]),
    category: z.enum([
      "unsupported_claim",
      "evidence_mismatch",
      "missing_counterevidence",
      "synthetic_overstatement",
      "actionability",
      "structure",
    ]),
    description: z.string().min(20).max(800),
    recommendation: z.string().min(20).max(800),
  })).max(12),
});

const followupAnswerSchema = z.object({
  title: z.string().min(4).max(80),
  summary: z.string().min(20).max(500),
  sections: z.array(z.object({
    heading: z.string().min(2).max(80),
    body: z.string().min(10).max(1000),
    bullets: z.array(z.string().min(8).max(500)).max(5),
  })).min(2).max(5),
  conclusion: z.string().min(20).max(500),
  citations: z.array(z.string()).max(5),
  caveat: z.string().min(10),
});

const syntheticInterviewSchema = z.object({
  sessions: z.array(z.object({
    personaPublicId: z.string().min(8),
    summary: z.string().min(40),
    insights: z.array(z.string().min(10)).min(2).max(5),
    quotes: z.array(z.string().min(10)).min(2).max(4),
    messages: z.array(z.object({
      role: z.enum(["interviewer", "persona"]),
      content: z.string().min(8),
    })).min(2).max(24),
  })).min(1).max(8),
});

const realtimeInterviewTurnSchema = z.object({
  action: z.enum(["followup", "next_question", "complete"]),
  message: z.string().min(4).max(1200),
  rationale: z.string().min(4).max(500),
  summary: z.string().max(1600),
  insights: z.array(z.string().min(4).max(500)).max(6),
  quotes: z.array(z.string().min(4).max(500)).max(6),
});

const realtimeInterviewTurnJsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["followup", "next_question", "complete"] },
    message: { type: "string", minLength: 4, maxLength: 1200 },
    rationale: { type: "string", minLength: 4, maxLength: 500 },
    summary: { type: "string", maxLength: 1600 },
    insights: { type: "array", maxItems: 6, items: { type: "string", minLength: 4, maxLength: 500 } },
    quotes: { type: "array", maxItems: 6, items: { type: "string", minLength: 4, maxLength: 500 } },
  },
  required: ["action", "message", "rationale", "summary", "insights", "quotes"],
  additionalProperties: false,
} as const;

const syntheticInterviewJsonSchema = {
  type: "object",
  properties: {
    sessions: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          personaPublicId: { type: "string", minLength: 8, maxLength: 120 },
          summary: { type: "string", minLength: 40, maxLength: 1600 },
          insights: {
            type: "array",
            minItems: 2,
            maxItems: 5,
            items: { type: "string", minLength: 10, maxLength: 500 },
          },
          quotes: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: { type: "string", minLength: 10, maxLength: 500 },
          },
          messages: {
            type: "array",
            minItems: 2,
            maxItems: 24,
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["interviewer", "persona"] },
                content: { type: "string", minLength: 8, maxLength: 1200 },
              },
              required: ["role", "content"],
              additionalProperties: false,
            },
          },
        },
        required: ["personaPublicId", "summary", "insights", "quotes", "messages"],
        additionalProperties: false,
      },
    },
  },
  required: ["sessions"],
  additionalProperties: false,
} as const;

const harnessInterviewSchema = z.object({
  interviews: z.array(z.object({
    personaName: z.string().min(2),
    batch: z.number().int().min(1).max(2),
    objective: z.string().min(10),
    summary: z.string().min(80),
    quotes: z.array(z.string().min(20)).min(2).max(4),
    insights: z.array(z.string().min(15)).min(2).max(5),
  })).min(1).max(10),
});

const harnessInterviewJsonSchema = {
  type: "object",
  properties: {
    interviews: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          personaName: { type: "string", minLength: 2, maxLength: 40 },
          batch: { type: "integer", minimum: 1, maximum: 2 },
          objective: { type: "string", minLength: 10, maxLength: 300 },
          summary: { type: "string", minLength: 80, maxLength: 1800 },
          quotes: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 20, maxLength: 600 } },
          insights: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", minLength: 15, maxLength: 500 } },
        },
        required: ["personaName", "batch", "objective", "summary", "quotes", "insights"],
        additionalProperties: false,
      },
    },
  },
  required: ["interviews"],
  additionalProperties: false,
} as const;

const audienceCallSchema = z.object({
  calls: z.array(z.object({
    personaName: z.string().min(2),
    archetype: z.string().min(2),
    objective: z.string().min(10),
    response: z.string().min(180),
    quotes: z.array(z.string().min(20)).min(2).max(4),
    signals: z.array(z.string().min(12)).min(2).max(5),
  })).min(1).max(4),
  directions: z.array(z.object({
    title: z.string().min(4),
    appeal: z.string().min(20),
    resistance: z.string().min(20),
    verdict: z.enum(["strong", "mixed", "weak"]),
  })).min(2).max(4),
  summary: z.string().min(60),
});

const audienceCallJsonSchema = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          personaName: { type: "string", minLength: 2, maxLength: 40 },
          archetype: { type: "string", minLength: 2, maxLength: 100 },
          objective: { type: "string", minLength: 10, maxLength: 300 },
          response: { type: "string", minLength: 180, maxLength: 3000 },
          quotes: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 20, maxLength: 600 } },
          signals: { type: "array", minItems: 2, maxItems: 5, items: { type: "string", minLength: 12, maxLength: 500 } },
        },
        required: ["personaName", "archetype", "objective", "response", "quotes", "signals"],
        additionalProperties: false,
      },
    },
    directions: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 4, maxLength: 120 },
          appeal: { type: "string", minLength: 20, maxLength: 700 },
          resistance: { type: "string", minLength: 20, maxLength: 700 },
          verdict: { type: "string", enum: ["strong", "mixed", "weak"] },
        },
        required: ["title", "appeal", "resistance", "verdict"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", minLength: 60, maxLength: 1600 },
  },
  required: ["calls", "directions", "summary"],
  additionalProperties: false,
} as const;

const researchDiscussionSchema = z.object({
  title: z.string().min(4),
  topic: z.string().min(10),
  participants: z.array(z.string().min(2)).min(2).max(10),
  messages: z.array(z.object({
    id: z.string().min(2),
    speaker: z.string().min(2),
    archetype: z.string().min(2),
    round: z.number().int().min(1).max(5),
    content: z.string().min(40),
  })).min(6).max(40),
  findings: z.array(z.string().min(20)).min(3).max(8),
  consensus: z.array(z.string().min(15)).min(1).max(5),
  disagreements: z.array(z.string().min(15)).min(1).max(5),
  positionShifts: z.array(z.string().min(15)).max(5),
  unexpectedThemes: z.array(z.string().min(15)).max(5),
});

const researchDiscussionJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 4, maxLength: 120 },
    topic: { type: "string", minLength: 10, maxLength: 1000 },
    participants: { type: "array", minItems: 2, maxItems: 10, items: { type: "string", minLength: 2, maxLength: 40 } },
    messages: {
      type: "array",
      minItems: 6,
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 2, maxLength: 80 },
          speaker: { type: "string", minLength: 2, maxLength: 40 },
          archetype: { type: "string", minLength: 2, maxLength: 100 },
          round: { type: "integer", minimum: 1, maximum: 5 },
          content: { type: "string", minLength: 40, maxLength: 1200 },
        },
        required: ["id", "speaker", "archetype", "round", "content"],
        additionalProperties: false,
      },
    },
    findings: { type: "array", minItems: 3, maxItems: 8, items: { type: "string", minLength: 20, maxLength: 700 } },
    consensus: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", minLength: 15, maxLength: 600 } },
    disagreements: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", minLength: 15, maxLength: 600 } },
    positionShifts: { type: "array", maxItems: 5, items: { type: "string", minLength: 15, maxLength: 600 } },
    unexpectedThemes: { type: "array", maxItems: 5, items: { type: "string", minLength: 15, maxLength: 600 } },
  },
  required: ["title", "topic", "participants", "messages", "findings", "consensus", "disagreements", "positionShifts", "unexpectedThemes"],
  additionalProperties: false,
} as const;

const followupAnswerJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 4, maxLength: 80 },
    summary: { type: "string", minLength: 20, maxLength: 500 },
    sections: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          heading: { type: "string", minLength: 2, maxLength: 80 },
          body: { type: "string", minLength: 10, maxLength: 1000 },
          bullets: {
            type: "array",
            maxItems: 5,
            items: { type: "string", minLength: 8, maxLength: 500 },
          },
        },
        required: ["heading", "body", "bullets"],
        additionalProperties: false,
      },
    },
    conclusion: { type: "string", minLength: 20, maxLength: 500 },
    citations: {
      type: "array",
      maxItems: 5,
      items: { type: "string", maxLength: 500 },
    },
    caveat: { type: "string", minLength: 10, maxLength: 1000 },
  },
  required: ["title", "summary", "sections", "conclusion", "citations", "caveat"],
  additionalProperties: false,
} as const;

const personaSchema = z.object({
  name: z.string().min(2),
  archetype: z.string().min(2),
  age: z.number().int().min(18).max(75),
  city: z.string().min(2),
  occupation: z.string().min(2),
  commute: z.string().min(5),
  budget: z.string().min(2),
  currentSituation: z.string().min(10),
  goals: z.array(z.string().min(4)).min(2).max(4),
  painPoints: z.array(z.string().min(4)).min(2).max(4),
  decisionStyle: z.string().min(8),
  tags: z.array(z.string().min(2)).min(3).max(5),
});

const panelResearchSchema = z.object({
  panel: z.object({
    title: z.string().min(4),
    description: z.string().min(20),
  }),
  personas: z.array(personaSchema).min(6).max(8),
  interviews: z.array(z.object({
    personaName: z.string().min(2),
    batch: z.number().int().min(1).max(2),
    objective: z.string().min(10),
    summary: z.string().min(40),
    quotes: z.array(z.string().min(10)).min(2).max(4),
    insights: z.array(z.string().min(10)).min(2).max(4),
  })).min(6).max(8),
  validation: z.object({
    directions: z.array(z.object({
      title: z.string().min(4),
      appeal: z.string().min(20),
      resistance: z.string().min(20),
      verdict: z.enum(["strong", "mixed", "weak"]),
    })).min(2).max(4),
    summary: z.string().min(40),
  }),
});

const personaPanelSchema = panelResearchSchema.pick({ panel: true, personas: true });
const validationResultSchema = panelResearchSchema.pick({ validation: true });

const planJsonSchema = {
  type: "object",
  properties: {
    studyType: { type: "string", enum: ["user_research", "fast_insight", "product_rnd", "panel_only"] },
    framework: { type: "string", minLength: 2, maxLength: 120 },
    methods: {
      type: "array",
      maxItems: 4,
      items: { type: "string", enum: ["Interview Chat", "Discussion Chat", "Scout Agent", "Fast Insight"] },
    },
    personaFilters: {
      type: "object",
      properties: {
        audience: { type: "string", minLength: 2, maxLength: 240 },
        source: { type: "string", minLength: 2, maxLength: 120 },
      },
      required: ["audience", "source"],
      additionalProperties: false,
    },
    personaCount: { type: "integer", minimum: 1, maximum: 20 },
    estimatedDurationMinutes: { type: "integer", minimum: 30, maximum: 4320 },
    estimatedTokens: { type: "integer", minimum: 10000, maximum: 250000 },
    rationale: { type: "string", minLength: 20, maxLength: 1200 },
  },
  required: [
    "studyType",
    "framework",
    "methods",
    "personaFilters",
    "personaCount",
    "estimatedDurationMinutes",
    "estimatedTokens",
    "rationale",
  ],
  additionalProperties: false,
} as const;

const clarificationOptionSetJsonSchema = {
  type: "object",
  properties: {
    question: { type: "string", minLength: 6, maxLength: 120 },
    options: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: { type: "string", minLength: 2, maxLength: 80 },
    },
  },
  required: ["question", "options"],
  additionalProperties: false,
} as const;

const clarificationJsonSchema = {
  type: "object",
  properties: {
    businessGoal: clarificationOptionSetJsonSchema,
    researchFocus: clarificationOptionSetJsonSchema,
    targetAudience: clarificationOptionSetJsonSchema,
    researchScope: clarificationOptionSetJsonSchema,
  },
  required: ["businessGoal", "researchFocus", "targetAudience", "researchScope"],
  additionalProperties: false,
} as const;

const reportJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 4, maxLength: 160 },
    executiveSummary: { type: "string", minLength: 80, maxLength: 3000 },
    findings: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 2, maxLength: 120 },
          insight: { type: "string", minLength: 40, maxLength: 1600 },
          evidence: { type: "string", minLength: 30, maxLength: 1600 },
          implication: { type: "string", minLength: 30, maxLength: 1200 },
          claimType: { type: "string", enum: ["fact", "human_observation", "synthetic_simulation", "model_inference"] },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          evidenceRefs: {
            type: "array",
            maxItems: 8,
            items: { type: "string", pattern: "^(web|synthetic|discussion)-[0-9]{2}$" },
          },
        },
        required: ["title", "insight", "evidence", "implication", "claimType", "confidence", "evidenceRefs"],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 2, maxLength: 120 },
          action: { type: "string", minLength: 30, maxLength: 1200 },
          rationale: { type: "string", minLength: 20, maxLength: 800 },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["title", "action", "rationale", "priority"],
        additionalProperties: false,
      },
    },
    limitations: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: { type: "string", minLength: 10, maxLength: 600 },
    },
    nextQuestions: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: { type: "string", minLength: 10, maxLength: 400 },
    },
  },
  required: ["title", "executiveSummary", "findings", "recommendations", "limitations", "nextQuestions"],
  additionalProperties: false,
} as const;

const reportQualityReviewJsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "revise"] },
    score: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string", minLength: 20, maxLength: 1200 },
    issues: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          category: {
            type: "string",
            enum: [
              "unsupported_claim",
              "evidence_mismatch",
              "missing_counterevidence",
              "synthetic_overstatement",
              "actionability",
              "structure",
            ],
          },
          description: { type: "string", minLength: 20, maxLength: 800 },
          recommendation: { type: "string", minLength: 20, maxLength: 800 },
        },
        required: ["severity", "category", "description", "recommendation"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "score", "summary", "issues"],
  additionalProperties: false,
} as const;

const panelResearchJsonSchema = {
  type: "object",
  properties: {
    panel: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 4, maxLength: 80 },
        description: { type: "string", minLength: 20, maxLength: 500 },
      },
      required: ["title", "description"],
      additionalProperties: false,
    },
    personas: {
      type: "array",
      minItems: 6,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 2, maxLength: 40 },
          archetype: { type: "string", minLength: 2, maxLength: 80 },
          age: { type: "integer", minimum: 18, maximum: 75 },
          city: { type: "string", minLength: 2, maxLength: 40 },
          occupation: { type: "string", minLength: 2, maxLength: 80 },
          commute: { type: "string", minLength: 5, maxLength: 240 },
          budget: { type: "string", minLength: 2, maxLength: 80 },
          currentSituation: { type: "string", minLength: 10, maxLength: 500 },
          goals: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 4, maxLength: 160 } },
          painPoints: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 4, maxLength: 160 } },
          decisionStyle: { type: "string", minLength: 8, maxLength: 300 },
          tags: { type: "array", minItems: 3, maxItems: 5, items: { type: "string", minLength: 2, maxLength: 30 } },
        },
        required: ["name", "archetype", "age", "city", "occupation", "commute", "budget", "currentSituation", "goals", "painPoints", "decisionStyle", "tags"],
        additionalProperties: false,
      },
    },
    interviews: {
      type: "array",
      minItems: 6,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          personaName: { type: "string", minLength: 2, maxLength: 40 },
          batch: { type: "integer", minimum: 1, maximum: 2 },
          objective: { type: "string", minLength: 10, maxLength: 300 },
          summary: { type: "string", minLength: 40, maxLength: 1200 },
          quotes: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 10, maxLength: 300 } },
          insights: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 10, maxLength: 300 } },
        },
        required: ["personaName", "batch", "objective", "summary", "quotes", "insights"],
        additionalProperties: false,
      },
    },
    validation: {
      type: "object",
      properties: {
        directions: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              title: { type: "string", minLength: 4, maxLength: 100 },
              appeal: { type: "string", minLength: 20, maxLength: 500 },
              resistance: { type: "string", minLength: 20, maxLength: 500 },
              verdict: { type: "string", enum: ["strong", "mixed", "weak"] },
            },
            required: ["title", "appeal", "resistance", "verdict"],
            additionalProperties: false,
          },
        },
        summary: { type: "string", minLength: 40, maxLength: 1000 },
      },
      required: ["directions", "summary"],
      additionalProperties: false,
    },
  },
  required: ["panel", "personas", "interviews", "validation"],
  additionalProperties: false,
} as const;

const personaPanelJsonSchema = {
  type: "object",
  properties: {
    panel: panelResearchJsonSchema.properties.panel,
    personas: panelResearchJsonSchema.properties.personas,
  },
  required: ["panel", "personas"],
  additionalProperties: false,
} as const;

export type ProviderStudyPlan = z.infer<typeof planSchema> & {
  source: "openai";
  responseId: string;
  model: string;
  promptVersion: string;
};

export type ProviderStudyClarification = z.infer<typeof clarificationSchema> & {
  responseId: string;
  model: string;
  promptVersion: string;
};

export type ResearchReport = z.infer<typeof reportSchema>;
export type ReportQualityReview = z.infer<typeof reportQualityReviewSchema>;
export type SyntheticPanelResearch = z.infer<typeof panelResearchSchema>;

export type ProviderReportQualityReview = ReportQualityReview & {
  responseId: string;
  model: string;
  provider: string;
  promptVersion: string;
  usage: unknown;
};

export type ResearchProgressEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

export type ResearchCitation = {
  title: string;
  url: string;
};

export type ProviderResearchReport = {
  report: ResearchReport;
  panelResearch: SyntheticPanelResearch;
  citations: ResearchCitation[];
  evidenceCatalog: ReturnType<typeof buildReportEvidenceCatalog>;
  responseId: string;
  model: string;
  promptVersion: string;
  usage: unknown;
};

export type ProviderResearchSources = {
  queries: string[];
  sources: PublicWebSource[];
  metadata: PublicWebSearchMetadata;
  audit?: SourceConnectorAuditSummary;
  audits?: SourceConnectorAuditSummary[];
  responseId: string;
  model: string;
  usage: unknown;
};

export type ProviderPersonaPanel = z.infer<typeof personaPanelSchema> & {
  responseId: string;
  model: string;
  usage: unknown;
};

export type ProviderResearchInterviews = SyntheticPanelResearch["interviews"];
export type ProviderResearchValidation = SyntheticPanelResearch["validation"];
export type ProviderResearchDiscussion = {
  title: string;
  topic: string;
  participantCount: number;
  participants: string[];
  messages: Array<{
    id: string;
    speaker: string;
    archetype: string;
    round: number;
    content: string;
  }>;
  findings: string[];
  consensus: string[];
  disagreements: string[];
  positionShifts: string[];
  unexpectedThemes: string[];
  instruction: string;
  timelineToken: string;
  disclaimer: string;
};

export type ProviderAudienceCall = {
  personaName: string;
  archetype: string;
  objective: string;
  response: string;
  quotes: string[];
  signals: string[];
};

export type ProviderDeepResearchValidation = ProviderResearchValidation & {
  calls: ProviderAudienceCall[];
};

export type ProviderFollowupAnswer = z.infer<typeof followupAnswerSchema> & {
  answer: string;
  responseId: string;
  model: string;
  promptVersion: string;
};

export type SyntheticInterviewResult = z.infer<typeof syntheticInterviewSchema>;
export type ProviderRealtimeInterviewTurn = z.infer<typeof realtimeInterviewTurnSchema> & {
  responseId: string;
  model: string;
  promptVersion: string;
  usage: unknown;
};

export type ProviderUniversalAgentTurn = z.infer<typeof universalAgentTurnSchema> & {
  responseId: string;
  model: string;
  promptVersion: string;
  usage: unknown;
};

let client: OpenAI | null = null;
let deepSeekClient: OpenAI | null = null;

export type ProviderStage = "plan" | "research" | "reasoning" | "report" | "judge" | "followup";
type ProviderProtocol = "responses" | "chat_completions";

export type ProviderRouteOverride = {
  stage: ProviderStage;
  providerName: string;
  model: string;
  protocol: ProviderProtocol;
};

const providerRouteStorage = new AsyncLocalStorage<ProviderRouteOverride>();

export function withProviderRoute<Result>(override: ProviderRouteOverride, callback: () => Promise<Result>) {
  return providerRouteStorage.run(override, callback);
}

function activeProviderRoute(stage: ProviderStage) {
  const override = providerRouteStorage.getStore();
  return override?.stage === stage ? override : null;
}

type ConversationMessage = {
  role: "user" | "assistant" | "system" | "developer";
  content: string;
};

type StructuredResponseRequest = {
  model: string;
  reasoning?: { effort: "low" | "medium" | "high" };
  safety_identifier?: string;
  store?: boolean;
  metadata?: Record<string, string>;
  instructions: string;
  input: string | ConversationMessage[];
  text: {
    format: {
      type: "json_schema";
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
};

type StructuredResponse = {
  id: string;
  model: string;
  output_text: string;
  usage: unknown;
};

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY_MISSING");
  }

  client ??= new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
  });
  return client;
}

function getDeepSeekClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY_MISSING");
  }

  deepSeekClient ??= new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
  });
  return deepSeekClient;
}

function configuredProvider(stage: ProviderStage) {
  const override = activeProviderRoute(stage);
  if (override) return override.providerName.trim().toLowerCase();
  if (stage === "followup") return "deepseek";
  const variable = stage === "plan"
    ? process.env.PLAN_PROVIDER
    : stage === "research"
      ? process.env.RESEARCH_PROVIDER
      : stage === "reasoning"
        ? process.env.REASONING_PROVIDER ?? process.env.RESEARCH_PROVIDER
        : stage === "report"
          ? process.env.REPORT_PROVIDER
          : process.env.REPORT_JUDGE_PROVIDER ?? process.env.REASONING_PROVIDER ?? process.env.RESEARCH_PROVIDER;
  return variable?.trim().toLowerCase() || process.env.OPENAI_PROVIDER_NAME?.trim().toLowerCase() || "openai";
}

function usesDeepSeek(stage: ProviderStage) {
  return configuredProvider(stage) === "deepseek";
}

function getProviderName(stage: ProviderStage) {
  return configuredProvider(stage);
}

function isProviderConfigured(stage: ProviderStage) {
  return usesDeepSeek(stage)
    ? Boolean(process.env.DEEPSEEK_API_KEY?.trim())
    : Boolean(process.env.OPENAI_API_KEY?.trim());
}

function getRequiredApiKey(stage: ProviderStage) {
  return usesDeepSeek(stage) ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
}

function getStageModel(stage: ProviderStage) {
  const override = activeProviderRoute(stage);
  if (override) return override.model;
  if (usesDeepSeek(stage)) {
    if (stage === "plan") {
      return process.env.DEEPSEEK_PLAN_MODEL?.trim()
        || process.env.DEEPSEEK_FAST_MODEL?.trim()
        || process.env.DEEPSEEK_MODEL?.trim()
        || DEFAULT_DEEPSEEK_MODEL;
    }
    if (stage === "research") {
      return process.env.DEEPSEEK_RESEARCH_MODEL?.trim()
        || process.env.DEEPSEEK_FAST_MODEL?.trim()
        || process.env.DEEPSEEK_MODEL?.trim()
        || DEFAULT_DEEPSEEK_MODEL;
    }
    if (stage === "followup") {
      return process.env.DEEPSEEK_FOLLOWUP_MODEL?.trim()
        || process.env.DEEPSEEK_FAST_MODEL?.trim()
        || process.env.DEEPSEEK_MODEL?.trim()
        || DEFAULT_DEEPSEEK_MODEL;
    }
    if (stage === "report") {
      return process.env.DEEPSEEK_REPORT_MODEL?.trim()
        || process.env.DEEPSEEK_REASONING_MODEL?.trim()
        || process.env.DEEPSEEK_MODEL?.trim()
        || DEFAULT_DEEPSEEK_REASONING_MODEL;
    }
    return process.env.REPORT_JUDGE_MODEL?.trim()
      || process.env.DEEPSEEK_REASONING_MODEL?.trim()
      || process.env.DEEPSEEK_MODEL?.trim()
      || DEFAULT_DEEPSEEK_REASONING_MODEL;
  }
  if (stage === "plan") return process.env.OPENAI_PLAN_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  if (stage === "research") return process.env.OPENAI_RESEARCH_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  if (stage === "reasoning") return process.env.REASONING_MODEL?.trim() || process.env.OPENAI_RESEARCH_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  if (stage === "report") return process.env.REPORT_MODEL?.trim() || process.env.OPENAI_RESEARCH_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  if (stage === "judge") return process.env.REPORT_JUDGE_MODEL?.trim() || process.env.REASONING_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

function getPlanModel() {
  return getStageModel("plan");
}

function getResearchModel() {
  return getStageModel("research");
}

function getFollowupModel() {
  return getStageModel("followup");
}

function getApiProtocol(stage: ProviderStage): ProviderProtocol {
  const override = activeProviderRoute(stage);
  if (override) return override.protocol;
  const configured = usesDeepSeek(stage)
    ? process.env.DEEPSEEK_API_PROTOCOL
    : process.env.OPENAI_API_PROTOCOL;
  return configured?.trim() === "chat_completions"
    ? "chat_completions" as const
    : "responses" as const;
}

function getProviderClient(stage: ProviderStage) {
  return usesDeepSeek(stage) ? getDeepSeekClient() : getClient();
}

async function createStructuredResponse(
  stage: ProviderStage,
  request: StructuredResponseRequest,
  options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal },
): Promise<StructuredResponse> {
  const providerClient = getProviderClient(stage);
  if (getApiProtocol(stage) === "chat_completions") {
    const completion = await providerClient.chat.completions.create({
      model: request.model,
      messages: [
        { role: "system", content: request.instructions },
        ...(typeof request.input === "string"
          ? [{ role: "user" as const, content: request.input }]
          : request.input),
      ],
      ...(!usesDeepSeek(stage) && request.reasoning?.effort
        ? { reasoning_effort: request.reasoning.effort }
        : {}),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.text.format.name,
          strict: request.text.format.strict,
          schema: request.text.format.schema,
        },
      },
    }, options);
    const rawCompletion = completion as unknown;
    if (typeof rawCompletion === "string") {
      const normalized = rawCompletion.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      if (normalized.startsWith("{") || normalized.startsWith("[")) {
        const parsed = JSON.parse(normalized) as Record<string, unknown>;
        const parsedChoices = Array.isArray(parsed.choices)
          ? parsed.choices as Array<{ message?: { content?: unknown } }>
          : [];
        const parsedContent = parsedChoices[0]?.message?.content;
        if (typeof parsedContent === "string" && parsedContent.trim()) {
          return {
            id: typeof parsed.id === "string" ? parsed.id : `chat_${Date.now()}`,
            model: typeof parsed.model === "string" ? parsed.model : request.model,
            output_text: parsedContent.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
            usage: parsed.usage ?? null,
          };
        }
        const nestedOutput = typeof parsed.output === "string"
          ? parsed.output
          : typeof parsed.data === "string"
            ? parsed.data
            : null;
        if (nestedOutput) {
          return {
            id: `chat_${Date.now()}`,
            model: request.model,
            output_text: nestedOutput.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
            usage: null,
          };
        }
        const required = Array.isArray(request.text.format.schema.required)
          ? request.text.format.schema.required.filter((key): key is string => typeof key === "string")
          : [];
        if (required.some((key) => !(key in parsed))) {
          throw new Error(`OPENAI_GATEWAY_SCHEMA_KEYS:${Object.keys(parsed).slice(0, 12).join(",") || "empty"}`);
        }
        return {
          id: `chat_${Date.now()}`,
          model: request.model,
          output_text: normalized,
          usage: null,
        };
      }
      throw new Error(`OPENAI_TEXT_RESPONSE:${normalized.slice(0, 240)}`);
    }
    const gatewayResult = completion as typeof completion & {
      code?: number;
      code_msg?: string;
      code_reason?: string;
    };
    const outputText = gatewayResult.choices?.[0]?.message.content;
    if (!outputText && gatewayResult.code && gatewayResult.code !== 200) {
      throw new Error(gatewayResult.code_reason || gatewayResult.code_msg || `UPSTREAM_${gatewayResult.code}`);
    }
    if (!outputText) throw new Error(`OPENAI_EMPTY_RESPONSE:${Object.keys(gatewayResult).join(",")}`);
    return {
      id: completion.id,
      model: completion.model,
      output_text: outputText,
      usage: completion.usage,
    };
  }

  const response = usesDeepSeek(stage)
    ? await providerClient.responses.create({
        model: request.model,
        reasoning: request.reasoning,
        instructions: request.instructions,
        input: request.input,
        text: request.text,
      }, options)
    : await providerClient.responses.create(request, options);
  return {
    id: response.id,
    model: response.model,
    output_text: response.output_text,
    usage: response.usage,
  };
}

async function createDeepSeekStructuredResponse(
  request: StructuredResponseRequest,
  options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal },
): Promise<StructuredResponse> {
  return createStructuredResponse("followup", request, options);
}

function safetyIdentifier(userPublicId: string) {
  return createHash("sha256").update(userPublicId).digest("hex");
}

function parseOutput<T>(outputText: string, schema: z.ZodType<T>) {
  let parsed: unknown;
  const normalized = outputText.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const objectStart = normalized.indexOf("{");
  const objectEnd = normalized.lastIndexOf("}");
  const jsonText = objectStart >= 0 && objectEnd > objectStart
    ? normalized.slice(objectStart, objectEnd + 1)
    : normalized;

  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`OPENAI_INVALID_JSON:${normalized.slice(0, 240)}`);
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`)
      .join(",");
    throw new Error(`OPENAI_INVALID_SCHEMA:${issues}`);
  }

  return result.data;
}

function isInvalidStructuredOutput(error: unknown) {
  return error instanceof Error
    && (error.message.startsWith("OPENAI_INVALID_JSON") || error.message.startsWith("OPENAI_INVALID_SCHEMA"));
}

function isRetryableProviderError(error: unknown) {
  if (
    error instanceof OpenAI.APIConnectionError
    || error instanceof OpenAI.APIConnectionTimeoutError
  ) return true;

  return error instanceof OpenAI.APIError
    && (error.status === 408 || error.status === 429 || error.status === 666 || (error.status ?? 0) >= 500);
}

async function retryProviderRequest<T>(request: () => Promise<T>) {
  const delays = [750, 2_000];

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (attempt >= delays.length || !isRetryableProviderError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

export function getProviderStageStatus(stage: ProviderStage) {
  return {
    stage,
    providerName: getProviderName(stage),
    configured: isProviderConfigured(stage),
    requiredVariable: getRequiredApiKey(stage),
    model: getStageModel(stage),
    protocol: getApiProtocol(stage),
  };
}

export function getOpenAIProviderStatus() {
  const plan = getProviderStageStatus("plan");
  const research = getProviderStageStatus("research");
  const reasoning = getProviderStageStatus("reasoning");
  const report = getProviderStageStatus("report");
  const judge = getProviderStageStatus("judge");
  return {
    providerName: research.providerName,
    configured: research.configured,
    requiredVariable: research.requiredVariable,
    planProviderName: plan.providerName,
    planConfigured: plan.configured,
    planRequiredVariable: plan.requiredVariable,
    planModel: plan.model,
    planProtocol: plan.protocol,
    researchProviderName: research.providerName,
    researchConfigured: research.configured,
    researchRequiredVariable: research.requiredVariable,
    researchModel: research.model,
    researchProtocol: research.protocol,
    reasoningProviderName: reasoning.providerName,
    reasoningConfigured: reasoning.configured,
    reasoningRequiredVariable: reasoning.requiredVariable,
    reasoningModel: reasoning.model,
    reasoningProtocol: reasoning.protocol,
    reportProviderName: report.providerName,
    reportConfigured: report.configured,
    reportRequiredVariable: report.requiredVariable,
    reportModel: report.model,
    reportProtocol: report.protocol,
    judgeProviderName: judge.providerName,
    judgeConfigured: judge.configured,
    judgeRequiredVariable: judge.requiredVariable,
    judgeModel: judge.model,
    judgeProtocol: judge.protocol,
    protocol: research.protocol,
  };
}

export function getFollowupProviderStatus() {
  return {
    providerName: "deepseek",
    configured: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    model: getFollowupModel(),
    protocol: getApiProtocol("followup"),
    stateMode: "application_managed" as const,
  };
}

export function describeOpenAIError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    const timedOut = error.message === "RUNTIME_TASK_TIMEOUT" || error.message === "RUNTIME_RUN_TIMEOUT";
    return {
      message: timedOut ? "研究任务超过执行时限，系统将按重试策略处理。" : "研究任务已取消。",
      status: null,
      code: timedOut ? "RUNTIME_TIMEOUT" : "RUNTIME_ABORTED",
      requestId: null,
    };
  }

  if (error instanceof Error && error.message === "RUNTIME_RATE_LIMITED") {
    return {
      message: "模型服务请求速率已达到当前工作区上限，任务将稍后继续。",
      status: 429,
      code: error.message,
      requestId: null,
    };
  }
  if (error instanceof Error && error.message === "DEEPSEEK_API_KEY_MISSING") {
    return {
      message: "服务器尚未配置 DEEPSEEK_API_KEY，DeepSeek 模型服务暂不可用。",
      status: null,
      code: error.message,
      requestId: null,
    };
  }

  if (error instanceof Error && error.message === "OPENAI_API_KEY_MISSING") {
    return {
      message: "模型服务尚未配置，无法执行访谈。",
      status: null,
      code: error.message,
      requestId: null,
    };
  }

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return {
      message: "上游模型服务响应超时，请稍后重试。",
      status: null,
      code: "UPSTREAM_TIMEOUT",
      requestId: null,
    };
  }

  if (error instanceof OpenAI.APIError) {
    if (error.status === 666) {
      const requestHint = error.requestID ? `请求编号：${error.requestID}` : "";
      return {
        message: `上游模型网关暂时拒绝了生成请求，请重新执行。${requestHint}`,
        status: error.status,
        code: error.code ?? "UPSTREAM_GATEWAY_REJECTED",
        requestId: error.requestID ?? null,
      };
    }

    if (error.status === 524) {
      return {
        message: "上游模型服务响应超时，请稍后重新执行。",
        status: error.status,
        code: error.code ?? "UPSTREAM_TIMEOUT",
        requestId: error.requestID ?? null,
      };
    }

    return {
      message: error.message.slice(0, 500),
      status: error.status ?? null,
      code: error.code ?? null,
      requestId: error.requestID ?? null,
    };
  }

  if (error instanceof Error && error.message.startsWith("OPENAI_INVALID_SCHEMA")) {
    return {
      message: "模型返回的研究结构不完整，请重新执行。",
      status: null,
      code: error.message,
      requestId: null,
    };
  }

  if (error instanceof Error && error.message.startsWith("OPENAI_INVALID_JSON")) {
    return {
      message: "模型返回的内容无法解析，请重新执行。",
      status: null,
      code: error.message,
      requestId: null,
    };
  }

  if (
    error instanceof Error
    && ["OPENAI_TEXT_RESPONSE", "OPENAI_GATEWAY_SCHEMA_KEYS", "OPENAI_EMPTY_RESPONSE"]
      .some((prefix) => error.message.startsWith(prefix))
  ) {
    return {
      message: "上游网关返回了不兼容的响应格式，请重试或切换网关。",
      status: null,
      code: "UPSTREAM_INCOMPATIBLE_RESPONSE",
      requestId: null,
    };
  }

  if (error instanceof Error && error.message === "PUBLIC_WEB_SOURCES_INSUFFICIENT") {
    return {
      message: "可核查的公开网页来源不足，请补充更具体的产品、地区或时间范围后重试。",
      status: null,
      code: error.message,
      requestId: null,
    };
  }

  return {
    message: error instanceof Error ? error.message.slice(0, 500) : "OPENAI_UNKNOWN_ERROR",
    status: null,
    code: null,
    requestId: null,
  };
}

export async function generateProviderUniversalAgentTurn(input: {
  objective: string;
  userPublicId: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  skills: Array<{ publicId: string; slug: string; name: string; description: string; version: number; executorType: string }>;
  files: Array<{ path: string; byteSize: number; version: number }>;
  externalExecutionAllowed: boolean;
}): Promise<ProviderUniversalAgentTurn> {
  const model = getStageModel("reasoning");
  const skillCatalog = input.skills.length
    ? input.skills.map((skill) => `${skill.publicId} | ${skill.slug}@${skill.version} | ${skill.name} | ${skill.executorType} | ${skill.description}`).join("\n")
    : "无已绑定工作区 Skill";
  const fileCatalog = input.files.length
    ? input.files.map((file) => `${file.path} (${file.byteSize} bytes, v${file.version})`).join("\n")
    : "Workspace 为空";
  const allowedActions = input.externalExecutionAllowed
    ? "list_files, read_file, write_file, execute_skill, finish"
    : "list_files, read_file, write_file, finish（本轮未获外部执行确认，禁止 execute_skill）";
  const response = await createStructuredResponse("reasoning", {
    model,
    reasoning: { effort: "medium" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: { surface: "universal_agent", prompt_version: UNIVERSAL_AGENT_PROMPT_VERSION },
    instructions: [
      "你是 atypica Universal Agent，负责在持久化工作区中协调受治理的 Skills 完成用户目标。",
      "每一步只能选择一个结构化动作。不要输出隐藏推理，只在 decisionSummary 中给出简短、可审计的选择依据。",
      "skills/ 是只读的版本化能力目录；工作文件只能写入普通相对路径，不得使用绝对路径、.. 或 skills/ 前缀。",
      "需要读取现有文件时先 read_file；需要了解目录时用 list_files；完成目标后使用 finish 并在 message 中给出结果。",
      "execute_skill 时必须使用目录中精确的 skillPublicId，并把参数编码为 JSON object 字符串放入 argumentsJson。",
      "不得声称工具已经执行，除非对话中已经出现对应 tool 结果。所有面向用户的文本使用简体中文。",
      `本轮允许动作：${allowedActions}`,
      `\n已绑定 Skills：\n${skillCatalog}`,
      `\n持久化 Workspace：\n${fileCatalog}`,
    ].join("\n"),
    input: [
      { role: "system", content: `当前目标：${input.objective}` },
      ...input.messages,
    ],
    text: {
      format: {
        type: "json_schema",
        name: "universal_agent_turn",
        strict: true,
        schema: universalAgentTurnJsonSchema,
      },
    },
  }, { timeout: 90_000, maxRetries: 1 });
  return {
    ...parseOutput(response.output_text, universalAgentTurnSchema),
    responseId: response.id,
    model: response.model,
    promptVersion: UNIVERSAL_AGENT_PROMPT_VERSION,
    usage: response.usage,
  };
}

export async function generateProviderStudyPlan(
  brief: string,
  userPublicId: string,
  clarificationContext?: string,
): Promise<ProviderStudyPlan> {
  const model = getPlanModel();
  const response = await createStructuredResponse("plan", {
    model,
    reasoning: { effort: "low" },
    safety_identifier: safetyIdentifier(userPublicId),
    store: true,
    metadata: { surface: "study_plan", prompt_version: PLAN_PROMPT_VERSION },
    instructions: [
      "你是商业研究设计师。把用户 Brief 转换成可执行、克制且透明的研究计划。",
      "方法只能从给定枚举中选择。不要声称已经完成访谈、抓取、Persona 模拟或数据收集。",
      "如果用户要求仅使用公开网页或公开资料，方法只能选择 Scout Agent 和/或 Fast Insight，不得选择 Interview Chat 或 Discussion Chat。",
      "personaFilters.source 应说明计划使用公开网页研究；如果方法包含访谈，它仅代表后续待实现的方法，不代表已招募真人。",
      "估算值用于产品排期，不代表 OpenAI API 的实际计费 Token。输出使用简体中文。",
    ].join("\n"),
    input: clarificationContext
      ? `原始 Brief：\n${brief}\n\n用户澄清答案：\n${clarificationContext}`
      : brief,
    text: {
      format: {
        type: "json_schema",
        name: "study_plan",
        strict: true,
        schema: planJsonSchema,
      },
    },
  });

  const plan = parseOutput(response.output_text, planSchema);

  return {
    ...plan,
    methods: plan.methods as StudyMethod[],
    source: "openai",
    responseId: response.id,
    model: response.model,
    promptVersion: PLAN_PROMPT_VERSION,
  };
}

export async function generateProviderStudyClarification(input: {
  brief: string;
  productLine: "research" | "market_insight";
  userPublicId: string;
}): Promise<ProviderStudyClarification> {
  const model = getPlanModel();
  const response = await createStructuredResponse("plan", {
    model,
    reasoning: { effort: "low" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: { surface: "study_clarification", prompt_version: CLARIFICATION_PROMPT_VERSION },
    instructions: [
      "你是商业研究设计师。根据用户当前提交的 Brief 生成四组必要的澄清问题。",
      "四组分别用于确认业务决策、研究重点、目标人群或市场范围、证据与方法范围。",
      "每组选项必须直接对应当前 Brief 中的研究对象、使用场景和决策语境；不得套用其他品类的术语、属性或人群。",
      "不要把共享单车、通勤或出行自动解释为电动车购买、续航、充电或换电，除非 Brief 明确提到这些内容。",
      "信息不足时使用与当前研究对象绑定的中性选项，不得虚构品牌、产品功能或用户事实。",
      "每组必须给出四个互不重复、可直接选择的简体中文选项；选项应简洁、具体且彼此有区分度。",
      `产品线：${input.productLine === "market_insight" ? "市场洞察" : "用户研究"}`,
    ].join("\n"),
    input: `当前 Brief：\n${input.brief}`,
    text: {
      format: {
        type: "json_schema",
        name: "study_clarification",
        strict: true,
        schema: clarificationJsonSchema,
      },
    },
  }, { timeout: 30_000, maxRetries: 1 });

  return {
    ...parseOutput(response.output_text, clarificationSchema),
    responseId: response.id,
    model: response.model,
    promptVersion: CLARIFICATION_PROMPT_VERSION,
  };
}

export async function generateProviderSyntheticInterviews(input: {
  title: string;
  objective: string;
  questions: string[];
  personas: Array<{
    publicId: string;
    name: string;
    archetype: string;
    profile: SyntheticPanelResearch["personas"][number];
  }>;
  userPublicId: string;
}) {
  const model = getResearchModel();
  const instructions = [
    "你是专业的用户研究访谈员，负责基于结构化 AI Persona 进行假设探索访谈。",
    "为输入 Persona 生成一场独立的中文模拟访谈，逐轮交替使用 interviewer 和 persona 角色，第一轮必须是 interviewer。",
    "必须逐字、按顺序使用输入的固定访谈问题；每个问题后只生成一条 persona 回答，不得改写、跳过或增加 interviewer 问题。",
    "回答必须符合 Persona 的背景、目标、痛点和决策方式，不得声称是真人经历或真实招募样本。",
    "summary、insights 和 quotes 只能概括本次合成对话。不得推断人群占比、统计显著性或市场普遍性。",
    "personaPublicId 必须逐字使用输入提供的 ID，只生成一个 session。",
  ].join("\n");
  const responses: StructuredResponse[] = [];

  // Some OpenAI-compatible gateways intermittently return a non-standard 666
  // response. Independent Persona requests keep retries small and isolated.
  for (const persona of input.personas) {
    responses.push(await retryProviderRequest(() => createStructuredResponse("research", {
      model,
      reasoning: { effort: "medium" },
      safety_identifier: safetyIdentifier(input.userPublicId),
      store: true,
      metadata: { surface: "synthetic_interview", prompt_version: INTERVIEW_PROMPT_VERSION },
      instructions,
      input: [
        `访谈项目：${input.title}`,
        `访谈目标：${input.objective}`,
        `固定访谈问题：\n${JSON.stringify(input.questions)}`,
        `AI Persona：\n${JSON.stringify(persona)}`,
      ].join("\n\n"),
      text: {
        format: {
          type: "json_schema",
          name: "synthetic_interview_session",
          strict: true,
          schema: syntheticInterviewJsonSchema,
        },
      },
    }, { timeout: 180_000, maxRetries: 0 })));
  }

  const sessions = responses.flatMap((response) => (
    parseOutput(response.output_text, syntheticInterviewSchema).sessions.map((session) => ({
      ...session,
      messages: session.messages.map((message, index) => message.role === "interviewer"
        ? { ...message, content: input.questions[Math.floor(index / 2)] ?? message.content }
        : message),
    }))
  ));
  const result = syntheticInterviewSchema.parse({ sessions });
  const expectedIds = new Set(input.personas.map((persona) => persona.publicId));
  const resultIds = new Set(result.sessions.map((session) => session.personaPublicId));
  const validIds = result.sessions.length === input.personas.length
    && resultIds.size === expectedIds.size
    && [...expectedIds].every((publicId) => resultIds.has(publicId));
  const validTurns = result.sessions.every((session) => (
    session.messages[0]?.role === "interviewer"
    && session.messages.every((message, index) => index === 0 || message.role !== session.messages[index - 1].role)
    && session.messages.filter((message) => message.role === "interviewer").length === input.questions.length
  ));
  if (!validIds || !validTurns) throw new Error("OPENAI_INVALID_SCHEMA");
  return {
    ...result,
    responseId: responses.map((response) => response.id).join(","),
    model: responses[0]?.model ?? model,
    promptVersion: INTERVIEW_PROMPT_VERSION,
  };
}

export async function generateProviderRealtimeInterviewTurn(input: {
  projectTitle: string;
  objective: string;
  fixedQuestions: string[];
  currentQuestionPosition: number;
  followupCount: number;
  maxFollowupsPerQuestion: number;
  conversation: Array<{ role: "agent" | "participant"; content: string }>;
  context: string;
  strategyInstruction: string;
  participantSafetyId: string;
  signal?: AbortSignal;
}): Promise<ProviderRealtimeInterviewTurn> {
  const model = getResearchModel();
  const currentQuestion = input.fixedQuestions[input.currentQuestionPosition - 1] ?? "";
  const isLastQuestion = input.currentQuestionPosition >= input.fixedQuestions.length;
  const response = await retryProviderRequest(() => createStructuredResponse("research", {
    model,
    reasoning: { effort: "low" },
    safety_identifier: safetyIdentifier(input.participantSafetyId),
    store: true,
    metadata: { surface: "realtime_interview", prompt_version: REALTIME_INTERVIEW_PROMPT_VERSION },
    instructions: [
      "你是专业、克制的中文用户研究访谈员，正在与一位真人参与者进行逐轮访谈。",
      "只根据参与者已经说过的话进行追问，不得补造经历、身份、观点或结论。",
      "固定问题必须按输入顺序逐字提问。选择 next_question 时，message 必须逐字等于下一个固定问题。",
      "只有当前回答明显缺少具体事件、决策原因或关键细节，并且仍有追问额度时，才选择 followup。每次只问一个简短问题。",
      "当前题达到追问上限时必须进入下一题；最后一题完成后必须选择 complete。",
      "complete 时 message 是简短致谢，summary、insights、quotes 只能依据本次真人对话；其他 action 时这三个字段返回空值或空数组。",
      "不得给参与者提供研究结论、建议或对其回答作价值判断。输出简体中文。",
      input.strategyInstruction ? `实验策略补充要求（不得覆盖上述固定规则）：${input.strategyInstruction}` : "",
    ].filter(Boolean).join("\n"),
    input: [
      `项目：${input.projectTitle}`,
      `目标：${input.objective}`,
      `固定问题：${JSON.stringify(input.fixedQuestions)}`,
      `当前题序号：${input.currentQuestionPosition}`,
      `当前固定问题：${currentQuestion}`,
      `是否最后一题：${isLastQuestion}`,
      `本题已追问次数：${input.followupCount}/${input.maxFollowupsPerQuestion}`,
      input.context ? `版本化 Context（仅作访谈背景，不得向参与者泄露内部资料）：\n${input.context}` : "",
      `对话记录：\n${JSON.stringify(input.conversation)}`,
    ].filter(Boolean).join("\n\n"),
    text: {
      format: {
        type: "json_schema",
        name: "realtime_interview_turn",
        strict: true,
        schema: realtimeInterviewTurnJsonSchema,
      },
    },
  }, { timeout: 90_000, maxRetries: 0, signal: input.signal }));
  const result = parseOutput(response.output_text, realtimeInterviewTurnSchema);
  return {
    ...result,
    responseId: response.id,
    model: response.model,
    promptVersion: REALTIME_INTERVIEW_PROMPT_VERSION,
    usage: response.usage,
  };
}

export async function generateProviderFollowupAnswer(input: {
  question: string;
  report: ResearchReport;
  citations: ResearchCitation[];
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  userPublicId: string;
  studyPublicId: string;
}): Promise<ProviderFollowupAnswer> {
  const model = getFollowupModel();
  const allowedUrls = new Set(input.citations.map((citation) => citation.url));
  const response = await retryProviderRequest(() => createDeepSeekStructuredResponse({
    model,
    reasoning: { effort: "low" },
    instructions: [
      "你是研究报告问答助手，只能依据输入的报告、局限和公开来源回答。",
      "不得把 AI 合成 Persona 或模拟访谈描述为真人研究，也不得补造统计比例、事实或来源。",
      "citations 只能返回输入来源列表中完全一致的 URL；没有直接来源支持时返回空数组。",
      "回答要直接回应问题，并清楚区分报告证据、分析推断和建议。",
      "使用适合长文阅读的结构：title 是简短结论标题；summary 是直接回答问题的导语；sections 为 2 至 5 个逻辑分节，每节包含 heading、body 和可扫描的 bullets；conclusion 汇总最重要的行动结论。",
      "分节之间不得重复；每个 bullet 只表达一个完整要点。不要在字段内容中使用 Markdown 标记或手写编号。",
      "你正在参与一段持续的多轮研究对话。回答当前问题时必须结合此前所有成功轮次，并保持术语、假设和结论一致。",
      "caveat 必须说明本回答最重要的证据边界或仍需真人研究验证的事项。输出简体中文。",
      "必须只输出一个可由 JSON.parse 直接解析的 JSON 对象，且只包含 title、summary、sections、conclusion、citations、caveat 六个字段。",
      "不得输出 Markdown 代码块、标题、前缀、后缀或 JSON 之外的解释。",
    ].join("\n"),
    input: [
      {
        role: "developer",
        content: [
          `研究 ID：${input.studyPublicId}`,
          `报告：${JSON.stringify(input.report)}`,
          `允许引用的公开来源：${JSON.stringify(input.citations)}`,
        ].join("\n\n"),
      },
      ...input.conversation,
      { role: "user", content: input.question },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "report_followup_answer",
        strict: true,
        schema: followupAnswerJsonSchema,
      },
    },
  }, { timeout: 90_000, maxRetries: 0 }));
  let parsedResponse = response;
  let result: z.infer<typeof followupAnswerSchema>;

  try {
    result = parseOutput(response.output_text, followupAnswerSchema);
  } catch (error) {
    if (!isInvalidStructuredOutput(error)) throw error;

    // DeepSeek's Responses compatibility layer can return completed Markdown even
    // when json_schema is requested. Ask the same provider to serialize its answer;
    // do not synthesize or persist a local fallback.
    parsedResponse = await retryProviderRequest(() => createDeepSeekStructuredResponse({
      model,
      reasoning: { effort: "low" },
      instructions: [
        "你是 JSON 结构修复器。将输入的模型回答转换为指定 JSON 结构。",
        "保留原回答的事实、分析和证据边界，不得新增事实或来源。",
        "将正文整理为 title、summary、sections、conclusion；sections 必须包含 2 至 5 个分节，每节含 heading、body、bullets。",
        "不得删减原回答中的关键结论；不要在字段内容中使用 Markdown 标记或手写编号。",
        "citations 只能包含允许来源中完全一致的 URL；无法确定时返回空数组。",
        "只输出可由 JSON.parse 直接解析的 JSON 对象，不得输出 Markdown 或任何额外文字。",
      ].join("\n"),
      input: [
        {
          role: "developer",
          content: `允许来源：${JSON.stringify(input.citations)}`,
        },
        {
          role: "user",
          content: `待转换的原回答：\n\n${response.output_text}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "report_followup_answer_repair",
          strict: true,
          schema: followupAnswerJsonSchema,
        },
      },
    }, { timeout: 90_000, maxRetries: 0 }));
    result = parseOutput(parsedResponse.output_text, followupAnswerSchema);
  }

  return {
    ...result,
    answer: [
      result.summary,
      ...result.sections.map((section) => [
        section.heading,
        section.body,
        ...section.bullets,
      ].join("\n")),
      result.conclusion,
    ].join("\n\n"),
    citations: result.citations.filter((url) => allowedUrls.has(url)),
    responseId: parsedResponse.id === response.id
      ? response.id
      : `${response.id},${parsedResponse.id}`,
    model: parsedResponse.model,
    promptVersion: FOLLOWUP_PROMPT_VERSION,
  };
}

export async function generateProviderResearchReport(input: {
  brief: string;
  framework: string;
  methods: StudyMethod[];
  audience: string;
  userPublicId: string;
  studyPublicId: string;
  onProgress?: (event: ResearchProgressEvent) => Promise<void> | void;
}): Promise<ProviderResearchReport> {
  const emit = async (type: string, payload: Record<string, unknown> = {}) => {
    await input.onProgress?.({ type, payload });
  };
  await emit("trend.scan.started", { focus: "category_and_charging" });
  const sourceResult = await researchPublicWeb({
    brief: input.brief,
    framework: input.framework,
    userPublicId: input.userPublicId,
    studyPublicId: input.studyPublicId,
  });
  const { queries, sources } = sourceResult;
  await emit("search.plan.completed", { queryCount: queries.length, queries });
  const sourceSummary = sources.map(({ title, url }) => ({ title, url }));
  const firstThird = Math.max(1, Math.ceil(sources.length / 3));
  const secondThird = Math.max(firstThird + 1, Math.ceil(sources.length * 2 / 3));
  await emit("trend.scan.completed", {
    focus: "category_and_charging",
    sourceCount: firstThird,
    sources: sourceSummary.slice(0, firstThird),
    provider: sourceResult.metadata.primaryProvider,
  });
  await emit("upgrade.scan.started", {
    focus: "replacement_and_brand_upgrade",
    evidenceCount: sources.length,
  });
  await emit("upgrade.scan.completed", {
    focus: "replacement_and_brand_upgrade",
    sourceCount: secondThird - firstThird,
    sources: sourceSummary.slice(firstThird, secondThird),
  });
  await emit("policy.research.started", {
    focus: "policy_and_industry_context",
    evidenceCount: sources.length,
  });
  await emit("policy.research.completed", {
    focus: "policy_and_industry_context",
    sourceCount: sources.length - secondThird,
    sources: sourceSummary.slice(secondThird),
    fallbackUsed: sourceResult.metadata.fallbackUsed,
  });

  await emit("personas.generate.started", { targetCount: 8 });
  const personaPanel = await buildProviderPersonaPanel({
    brief: input.brief,
    framework: input.framework,
    methods: input.methods,
    audience: input.audience,
    userPublicId: input.userPublicId,
    studyPublicId: input.studyPublicId,
    sources,
  });
  await emit("personas.generated", {
    count: personaPanel.personas.length,
    names: personaPanel.personas.map((persona) => persona.name),
  });
  await emit("panel.create.started", { personaCount: personaPanel.personas.length });
  await emit("panel.created", { title: personaPanel.panel.title, count: personaPanel.personas.length });

  const splitIndex = Math.ceil(personaPanel.personas.length / 2);
  await emit("interviews.batch1.started", {
    participantCount: splitIndex,
    objective: "换购触发、信息搜索、比较筛选和最终决策路径",
  });
  const batchOne = simulateProviderResearchInterviews(personaPanel.personas, 1);
  await emit("interviews.batch1.completed", {
    participantCount: batchOne.length,
    participants: batchOne.map((interview) => interview.personaName),
  });
  await emit("interviews.batch2.started", {
    participantCount: personaPanel.personas.length - splitIndex,
    objective: "真实使用体验、关键焦虑、场景变化和功能机会",
  });
  const batchTwo = simulateProviderResearchInterviews(personaPanel.personas, 2);
  await emit("interviews.batch2.completed", {
    participantCount: batchTwo.length,
    participants: batchTwo.map((interview) => interview.personaName),
  });

  await emit("validation.started", { candidateCount: 3 });
  const validation = validateProviderResearchDirections(personaPanel.personas);
  await emit("validation.completed", {
    directionCount: validation.directions.length,
    directions: validation.directions.map(({ title, verdict }) => ({ title, verdict })),
  });
  const panelResearch = panelResearchSchema.parse({
    panel: personaPanel.panel,
    personas: personaPanel.personas,
    interviews: [...batchOne, ...batchTwo],
    validation,
  });
  await emit("report.synthesis.started", {
    evidenceCharacters: sources.reduce((total, source) => total + source.excerpt.length, 0),
    personaCount: panelResearch.personas.length,
    interviewCount: panelResearch.interviews.length,
  });
  const reportResult = await synthesizeProviderResearchReport({
    brief: input.brief,
    framework: input.framework,
    methods: input.methods,
    audience: input.audience,
    userPublicId: input.userPublicId,
    studyPublicId: input.studyPublicId,
    queries,
    sources,
    panelResearch,
  });

  return {
    report: reportResult.report,
    panelResearch,
    citations: sources.map(({ title, url }) => ({ title, url })),
    evidenceCatalog: buildReportEvidenceCatalog({ sources, panelResearch }),
    responseId: reportResult.responseId,
    model: reportResult.model,
    promptVersion: REPORT_PROMPT_VERSION,
    usage: reportResult.usage,
  };
}

export async function researchPublicWeb(input: {
  brief: string;
  framework: string;
  userPublicId: string;
  studyPublicId: string;
  auditScope?: {
    workspaceId: string;
    studyId: string;
    runId: string;
    taskKey: string;
    attempt: number;
  };
  signal?: AbortSignal;
  additionalSeedUrls?: string[];
}): Promise<ProviderResearchSources> {
  const model = getResearchModel();
  const queryResponse = await createStructuredResponse("research", {
    model,
    reasoning: { effort: "low" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: false,
    metadata: {
      surface: "public_web_query_planning",
      prompt_version: REPORT_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "把商业研究 Brief 转换成公开网页检索计划。",
      "queries 提供 3 到 5 条适合网页搜索的短检索词，同时覆盖中文和英文，不要使用只有地区或年份的宽泛词。",
      "seedUrls 提供 4 到 16 个你已知且最可能真实存在的 https 官方页面，优先选择产品、定价、隐私、安全、服务条款和客户案例页面。",
      "seedUrls 不得使用搜索结果页、百科、门户首页或虚构路径；不确定时宁可给供应商官网首页。",
      "同时覆盖中文和英文公开网页；包含核心品类、关键维度、地区与时间范围。",
      "不要添加解释。",
    ].join("\n"),
    input: `研究 Brief：${input.brief}\n研究框架：${input.framework}`,
    text: {
      format: {
        type: "json_schema",
        name: "public_web_source_plan",
        strict: true,
        schema: searchSourcePlanJsonSchema,
      },
    },
  }, { signal: input.signal });
  const sourcePlan = parseOutput(queryResponse.output_text, searchSourcePlanSchema);
  const queries = sourcePlan.queries.slice(0, 5);
  const seedUrls = [...new Set([...(input.additionalSeedUrls ?? []), ...sourcePlan.seedUrls])].slice(0, 24);
  const collected = await collectPublicWebSources(queries, seedUrls, input.signal);
  const socialStatus = getBlueskyPublicConnectorStatus();
  const social = socialStatus.enabled
    ? await collectBlueskyPublicSources(queries, input.signal)
    : null;
  const sources = [...collected.sources, ...(social?.sources ?? [])];

  if (sources.length < 3) {
    throw new Error("PUBLIC_WEB_SOURCES_INSUFFICIENT");
  }

  if (input.auditScope) {
    const auditScope = input.auditScope;
    const database = await getDatabase();
    const prepared: PreparedSourceConnectorAudit[] = [];
    try {
      for (const audit of [collected.audit, ...(social ? [social.audit] : [])]) {
        prepared.push(await prepareSourceConnectorAuditRawStorage({ workspaceId: auditScope.workspaceId, audit }));
      }
      await database.transaction(async (transaction) => {
        for (const item of prepared) {
          await materializeSourceConnectorAudit(transaction, { ...auditScope, audit: item.audit });
        }
      });
    } catch (error) {
      await Promise.all(prepared.map(cleanupPreparedSourceRawStorage));
      throw error;
    }
    collected.audit = prepared[0].audit;
    if (social) social.audit = prepared[1].audit;
  }

  const audits = [collected.audit, ...(social ? [social.audit] : [])].map(summarizeSourceConnectorAudit);

  return {
    queries,
    sources,
    metadata: {
      ...collected.metadata,
      finalSourceCount: sources.length,
      socialConnectorEnabled: socialStatus.enabled,
      socialSourceCount: social?.sources.length ?? 0,
      socialCandidateCount: social?.audit.candidateCount ?? 0,
      socialConnectorRunPublicId: social?.audit.publicId,
    },
    audit: audits[0],
    audits,
    responseId: queryResponse.id,
    model: queryResponse.model,
    usage: queryResponse.usage,
  };
}

export async function buildProviderPersonaPanel(input: {
  brief: string;
  framework: string;
  methods: StudyMethod[];
  audience: string;
  userPublicId: string;
  studyPublicId: string;
  sources: PublicWebSource[];
  existingPersonas?: Array<{
    name: string;
    archetype: string;
    city: string;
    occupation: string;
    goals: string[];
    painPoints: string[];
  }>;
  signal?: AbortSignal;
}): Promise<ProviderPersonaPanel> {
  const model = getResearchModel();
  const sources = input.sources;
  const panelEvidencePacket = sources.map((source, index) => (
    `[S${index + 1}] ${source.title}\n${source.excerpt.slice(0, 1200)}`
  )).join("\n\n");
  const panelResponse = await createStructuredResponse("research", {
    model,
    reasoning: { effort: "medium" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: {
      surface: "synthetic_persona_panel",
      prompt_version: REPORT_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "你是研究模拟系统。仅根据 Brief 与公开网页证据构建 6 到 8 个差异化的 AI 合成 Persona。",
      "Persona 不是现实中的真人，不得写成已招募的真实受访者或统计代表性样本。",
      "覆盖不同城市、年龄、职业、预算、决策风格与使用情境，避免刻板印象和仅改名字的重复画像。",
      "Panel 标题和说明应概括共同研究场景。输出简体中文。",
    ].join("\n"),
    input: [
      `研究 Brief：${input.brief}`,
      `研究框架：${input.framework}`,
      `目标受众：${input.audience}`,
      `计划方法：${input.methods.join("、") || "AI 合成 Persona 模拟"}`,
      `工作区已检索 Persona：\n${input.existingPersonas?.length
        ? JSON.stringify(input.existingPersonas)
        : "没有匹配到可复用画像。请从当前证据生成完整的差异化 Persona 集合。"}`,
      "已检索 Persona 只用于保持命名、场景和痛点差异；不要声称这些画像是真人样本，也不要机械复制。",
      `公开网页证据摘要：\n${panelEvidencePacket}`,
    ].join("\n\n"),
    text: {
      format: {
        type: "json_schema",
        name: "synthetic_persona_panel",
        strict: true,
        schema: personaPanelJsonSchema,
      },
    },
  }, { timeout: 180_000, signal: input.signal });
  return {
    ...parseOutput(panelResponse.output_text, personaPanelSchema),
    responseId: panelResponse.id,
    model: panelResponse.model,
    usage: panelResponse.usage,
  };
}

export function simulateProviderResearchInterviews(
  personas: ProviderPersonaPanel["personas"],
  batch: 1 | 2,
): ProviderResearchInterviews {
  const splitIndex = Math.ceil(personas.length / 2);
  const selected = batch === 1 ? personas.slice(0, splitIndex) : personas.slice(splitIndex);
  const focus = batch === 1
    ? "换购触发、信息搜索、比较筛选和最终决策路径"
    : "真实使用体验、关键焦虑、场景变化和功能机会";

  return selected.map((persona) => ({
      personaName: persona.name,
      batch,
      objective: focus,
      summary: `${persona.name} 的模拟回答以“${persona.archetype}”的处境为约束。当前情境为：${persona.currentSituation}。围绕${focus}，该 Persona 会采用以下决策方式：${persona.decisionStyle}。优先处理${persona.painPoints[0]}与${persona.painPoints[1]}。这是一份由结构化 Persona 推演出的 AI 模拟，不是现实受访者陈述。`,
      quotes: [
        `对我来说，${persona.goals[0]}比单纯增加功能更重要；如果${persona.painPoints[0]}没有解决，我不会轻易改变选择。`,
        `我会结合${persona.commute}的实际情况判断，预算大致是${persona.budget}，最终还是要看方案能不能稳定降低日常的不确定性。`,
      ],
      insights: [
        `${persona.archetype}更看重${persona.goals[0]}，产品沟通应落到具体使用场景。`,
        `${persona.painPoints[0]}与${persona.painPoints[1]}会共同构成决策阻力。`,
      ],
    }));
}

export async function generateProviderResearchInterviews(input: {
  brief: string;
  audience: string;
  userPublicId: string;
  studyPublicId: string;
  personas: ProviderPersonaPanel["personas"];
  batch: 1 | 2;
  signal?: AbortSignal;
}): Promise<ProviderResearchInterviews> {
  const splitIndex = Math.ceil(input.personas.length / 2);
  const selected = input.batch === 1 ? input.personas.slice(0, splitIndex) : input.personas.slice(splitIndex);
  const objective = input.batch === 1
    ? "换购触发、信息搜索、比较筛选和最终决策路径"
    : "真实使用体验、关键焦虑、场景变化和功能机会";
  const response = await createStructuredResponse("research", {
    model: getResearchModel(),
    reasoning: { effort: "medium" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: {
      surface: "research_harness_interviews",
      prompt_version: HARNESS_INTERVIEW_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "你是定性研究模拟器，依据结构化 AI 合成 Persona 生成深度访谈记录。",
      "每位 Persona 必须保持其年龄、城市、职业、预算、场景、目标、痛点和决策方式的一致性。",
      "summary 要呈现触发事件、取舍过程、情绪、反例和条件变化；quotes 使用第一人称自然表达。",
      "不得把模拟内容写成真人访谈、真实比例或统计结论。输出简体中文。",
    ].join("\n"),
    input: [
      `研究 Brief：${input.brief}`,
      `目标受众：${input.audience}`,
      `本批研究目标：${objective}`,
      `Persona：${JSON.stringify(selected)}`,
      `请仅为以上 ${selected.length} 位 Persona 生成 batch=${input.batch} 的访谈结果。`,
    ].join("\n\n"),
    text: { format: { type: "json_schema", name: "research_harness_interviews", strict: true, schema: harnessInterviewJsonSchema } },
  }, { timeout: 180_000, signal: input.signal });
  return parseOutput(response.output_text, harnessInterviewSchema).interviews;
}

export function validateProviderResearchDirections(
  personas: ProviderPersonaPanel["personas"],
): ProviderResearchValidation {
  const recurringGoals = personas.flatMap((persona) => persona.goals).slice(0, 3);
  const recurringPainPoints = personas.flatMap((persona) => persona.painPoints).slice(0, 3);
  const validation = validationResultSchema.parse({
    validation: {
      directions: recurringGoals.map((goal, index) => ({
        title: `方向 ${index + 1}：围绕“${goal}”优化`,
        appeal: `该方向直接响应部分合成 Persona 的目标，并可结合公开来源中与${goal}相关的场景证据进行产品定义。`,
        resistance: `主要阻力来自${recurringPainPoints[index] ?? recurringPainPoints[0]}，仍需通过真人研究或实际市场测试验证接受度。`,
        verdict: index === 0 ? "strong" as const : "mixed" as const,
      })),
      summary: "方向验证来自公开证据与 AI 合成 Persona 的结构化推演，用于发现假设与压力测试，不代表真实用户占比、购买意愿或统计显著性。",
    },
  }).validation;
  return validation;
}

export async function runProviderAudienceCall(input: {
  brief: string;
  audience: string;
  userPublicId: string;
  studyPublicId: string;
  personas: ProviderPersonaPanel["personas"];
  interviews: ProviderResearchInterviews;
  signal?: AbortSignal;
}): Promise<ProviderDeepResearchValidation> {
  const selected = input.personas.slice(0, Math.min(3, input.personas.length));
  const response = await createStructuredResponse("reasoning", {
    model: getStageModel("reasoning"),
    reasoning: { effort: "medium" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: {
      surface: "research_harness_audience_call",
      prompt_version: AUDIENCE_CALL_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "你是 Audience Call 模拟工具。先让每位选中 Persona 以第一人称完整回答，再跨回答提炼候选方向。",
      "response 必须包含具体经历、犹豫、权衡、触发条件、不可接受条件和最终判断，不能只是摘要或标签。",
      "directions 只代表合成 Persona 的压力测试，不代表真人偏好、市场占比或统计显著性。",
      "保持 Persona 设定一致，输出简体中文。",
    ].join("\n"),
    input: [
      `研究 Brief：${input.brief}`,
      `目标受众：${input.audience}`,
      `Persona：${JSON.stringify(selected)}`,
      `已有模拟访谈：${JSON.stringify(input.interviews)}`,
      "请围绕最关键的产品选择、阻力和机会进行一轮深度 Audience Call。",
    ].join("\n\n"),
    text: { format: { type: "json_schema", name: "research_harness_audience_call", strict: true, schema: audienceCallJsonSchema } },
  }, { timeout: 180_000, signal: input.signal });
  return parseOutput(response.output_text, audienceCallSchema);
}

export async function runProviderDiscussionChat(input: {
  brief: string;
  audience: string;
  userPublicId: string;
  studyPublicId: string;
  personas: ProviderPersonaPanel["personas"];
  interviews: ProviderResearchInterviews;
  validation?: ProviderDeepResearchValidation;
  instruction: string;
  timelineToken: string;
  signal?: AbortSignal;
}): Promise<ProviderResearchDiscussion> {
  const participants = input.personas.slice(0, 10);
  const response = await createStructuredResponse("reasoning", {
    model: getStageModel("reasoning"),
    reasoning: { effort: "high" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: {
      surface: "research_harness_discussion",
      prompt_version: DISCUSSION_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "你是焦点小组主持与多角色对话模拟器。严格遵守主持 instruction，让 Persona 互相回应，而不是各自独立陈述。",
      "至少包含三轮：初始立场、相互追问或反驳、听取他人后的修正或坚持。",
      "messages 要体现分歧、共识、误解澄清、立场变化和意外主题；每条发言保持对应 Persona 的约束。",
      "不得把合成讨论表述为真人焦点小组或统计证据。输出简体中文。",
    ].join("\n"),
    input: [
      `研究 Brief：${input.brief}`,
      `目标受众：${input.audience}`,
      `主持 instruction：${input.instruction}`,
      `timelineToken：${input.timelineToken}`,
      `Persona：${JSON.stringify(participants)}`,
      `已有模拟访谈：${JSON.stringify(input.interviews)}`,
      `Audience Call：${input.validation ? JSON.stringify(input.validation) : "未执行"}`,
    ].join("\n\n"),
    text: { format: { type: "json_schema", name: "research_harness_discussion", strict: true, schema: researchDiscussionJsonSchema } },
  }, { timeout: 240_000, signal: input.signal });
  const parsed = parseOutput(response.output_text, researchDiscussionSchema);
  const messages = [...parsed.messages];
  const messageCounts = new Map<string, number>();
  for (const message of messages) messageCounts.set(message.speaker, (messageCounts.get(message.speaker) ?? 0) + 1);
  for (const [index, persona] of participants.entries()) {
    const count = messageCounts.get(persona.name) ?? 0;
    if (count < 1) {
      messages.push({
        id: `panel-round-1-${index + 1}`,
        speaker: persona.name,
        archetype: persona.archetype,
        round: 1,
        content: `以我的处境而言，${persona.goals[0]}是判断方案价值的起点，但${persona.painPoints[0]}会让我保持谨慎。我需要方案适配${persona.commute}，并在${persona.budget}的预算约束内证明实际价值。`,
      });
    }
    if (count < 2) {
      messages.push({
        id: `panel-round-3-${index + 1}`,
        speaker: persona.name,
        archetype: persona.archetype,
        round: 3,
        content: `听取其他人的分歧后，我会坚持用“${persona.decisionStyle}”做最终判断。若产品不能降低${persona.painPoints[1] ?? persona.painPoints[0]}带来的不确定性，我不会仅因为新增智能功能而改变选择。`,
      });
    }
  }
  return {
    ...parsed,
    participantCount: participants.length,
    participants: participants.map((persona) => persona.name),
    messages: messages.toSorted((left, right) => left.round - right.round),
    instruction: input.instruction,
    timelineToken: input.timelineToken,
    disclaimer: "本讨论由结构化 AI 合成 Persona 推演生成，不是现实受访者陈述，也不具备统计代表性。",
  };
}

export async function synthesizeProviderResearchReport(input: {
  brief: string;
  framework: string;
  methods: StudyMethod[];
  audience: string;
  userPublicId: string;
  studyPublicId: string;
  queries: string[];
  sources: PublicWebSource[];
  panelResearch?: SyntheticPanelResearch;
  discussion?: ProviderResearchDiscussion;
  signal?: AbortSignal;
}): Promise<{
  report: ResearchReport;
  responseId: string;
  model: string;
  provider: string;
  promptVersion: string;
  usage: unknown;
}> {
  const model = getStageModel("report");
  const evidenceCatalog = buildReportEvidenceCatalog(input);
  const evidencePacket = formatReportEvidenceCatalog(evidenceCatalog);
  const allowedEvidenceRefs = new Set(evidenceCatalog.map((item) => item.ref));
  const response = await createStructuredResponse("report", {
    model,
    reasoning: { effort: "medium" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: {
      surface: "public_web_research",
      prompt_version: REPORT_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "你是严谨的商业研究员。只根据输入中的公开网页证据包生成可审计的中文报告。",
      "清楚区分公开来源事实、AI 合成 Persona 模拟、分析推断和建议。不得把模拟访谈写成真人研究或具有统计代表性的证据。",
      "每条 finding 必须给出 claimType、confidence 和 evidenceRefs。evidenceRefs 只能使用证据目录中出现的 ID；没有直接证据时必须返回空数组、使用 model_inference 和 low confidence，并写入 limitations。",
      "fact 只能由 public_web 等事实证据支持；synthetic_simulation 只能表示 AI 合成访谈或讨论，不得写成真人观察。human_observation 只有输入存在真人访谈证据时才允许使用。",
      "没有买方侧直接证据时，不得在标题、洞察或总结中使用“最关注、首要、普遍、主要偏好”等排序断言；规范性建议应使用“应当、可作为、建议”措辞，并明确它不是已验证的市场事实。",
      "搜索摘要可能不完整，涉及采购或合规决策时应建议复核原始页面。优先采用近期、权威且彼此独立的来源。",
      "报告应直接服务业务决策，避免泛泛而谈。",
    ].join("\n"),
    input: [
      `研究 Brief：${input.brief}`,
      `研究框架：${input.framework}`,
      `计划方法：${input.methods.join("、") || "公开网页研究"}`,
      `目标受众：${input.audience}`,
      `实际检索词：${input.queries.join("；")}`,
      `公开网页证据包：\n${evidencePacket}`,
      `AI 合成 Panel 模拟：\n${input.panelResearch
        ? JSON.stringify(input.panelResearch)
        : "本次未执行 Persona 或模拟访谈，不得补造相关证据。"}`,
      `AI 合成焦点讨论：\n${input.discussion
        ? JSON.stringify(input.discussion)
        : "本次未执行焦点讨论，不得补造讨论结论。"}`,
      "请给出关键发现、证据、业务含义、行动建议、局限与下一步问题。",
    ].join("\n\n"),
    text: {
      format: {
        type: "json_schema",
        name: "public_web_research_report",
        strict: true,
        schema: reportJsonSchema,
      },
    },
  }, { timeout: 180_000, signal: input.signal });

  const report = parseOutput(response.output_text, reportSchema);
  for (const finding of report.findings) {
    finding.evidenceRefs = finding.evidenceRefs.filter((ref) => allowedEvidenceRefs.has(ref));
    if (!finding.evidenceRefs.length) {
      finding.claimType = "model_inference";
      finding.confidence = "low";
    }
  }
  return {
    report,
    responseId: response.id,
    model: response.model,
    provider: getProviderName("report"),
    promptVersion: REPORT_PROMPT_VERSION,
    usage: response.usage,
  };
}

export async function judgeProviderResearchReport(input: {
  report: ResearchReport;
  evidenceCatalog: ReturnType<typeof buildReportEvidenceCatalog>;
  userPublicId: string;
  studyPublicId: string;
  signal?: AbortSignal;
}): Promise<ProviderReportQualityReview> {
  const response = await createStructuredResponse("judge", {
    model: getStageModel("judge"),
    reasoning: { effort: "high" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: {
      surface: "research_report_quality_review",
      prompt_version: REPORT_JUDGE_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "你是独立的研究报告质量评审员。只审查报告，不重写报告。输出简体中文。",
      "逐条核对 finding 的 evidenceRefs、claimType、confidence 与证据目录是否一致，重点识别无依据的事实、把 AI 合成模拟误写成真人研究、忽略反向证据以及无法执行的建议。",
      "score 为 0 到 100 的整数。存在任何 high severity 问题，或存在两项及以上 medium severity 问题时，verdict 必须为 revise。",
      "issues 只记录具体、可修订的问题。verdict 为 revise 时至少提供一项 issue；verdict 为 approved 时允许 issues 为空。",
      "不得补充证据目录之外的新事实，也不得因为文风偏好要求无意义改写。",
    ].join("\n"),
    input: [
      `待评审报告：\n${JSON.stringify(input.report)}`,
      `允许使用的证据目录：\n${formatReportEvidenceCatalog(input.evidenceCatalog)}`,
    ].join("\n\n"),
    text: {
      format: {
        type: "json_schema",
        name: "research_report_quality_review",
        strict: true,
        schema: reportQualityReviewJsonSchema,
      },
    },
  }, { timeout: 180_000, signal: input.signal });
  const review = parseOutput(response.output_text, reportQualityReviewSchema);
  if (review.verdict === "revise" && review.issues.length === 0) {
    throw new Error("OPENAI_INVALID_SCHEMA:issues:too_small");
  }
  return {
    ...review,
    responseId: response.id,
    model: response.model,
    provider: getProviderName("judge"),
    promptVersion: REPORT_JUDGE_PROMPT_VERSION,
    usage: response.usage,
  };
}

export async function reviseProviderResearchReport(input: {
  report: ResearchReport;
  review: ReportQualityReview;
  evidenceCatalog: ReturnType<typeof buildReportEvidenceCatalog>;
  userPublicId: string;
  studyPublicId: string;
  signal?: AbortSignal;
}): Promise<{
  report: ResearchReport;
  responseId: string;
  model: string;
  provider: string;
  promptVersion: string;
  usage: unknown;
}> {
  const allowedEvidenceRefs = new Set(input.evidenceCatalog.map((item) => item.ref));
  const response = await createStructuredResponse("report", {
    model: getStageModel("report"),
    reasoning: { effort: "medium" },
    safety_identifier: safetyIdentifier(input.userPublicId),
    store: true,
    metadata: {
      surface: "research_report_targeted_revision",
      prompt_version: REPORT_REVISION_PROMPT_VERSION,
      study_id: input.studyPublicId,
    },
    instructions: [
      "你是严谨的商业研究报告编辑。根据独立评审的问题清单定向修订原报告，输出完整修订版简体中文报告。",
      "只处理评审指出的问题，保留原报告中没有问题的内容、结构和粒度。不得引入证据目录之外的新事实或新的 evidenceRefs。",
      "严格区分公开来源事实、AI 合成模拟、分析推断与建议。没有直接证据的判断必须使用 model_inference、low confidence 和空 evidenceRefs。",
      "不得把 AI 合成 Persona、模拟访谈或模拟讨论表述为真人研究或统计证据。",
      "修订后每条 finding 的 evidenceRefs 必须来自允许证据目录，并与 claimType 和 confidence 一致。",
    ].join("\n"),
    input: [
      `原报告：\n${JSON.stringify(input.report)}`,
      `评审结论：\n${JSON.stringify(input.review)}`,
      `允许使用的证据目录：\n${formatReportEvidenceCatalog(input.evidenceCatalog)}`,
    ].join("\n\n"),
    text: {
      format: {
        type: "json_schema",
        name: "revised_public_web_research_report",
        strict: true,
        schema: reportJsonSchema,
      },
    },
  }, { timeout: 180_000, signal: input.signal });
  const report = parseOutput(response.output_text, reportSchema);
  for (const finding of report.findings) {
    finding.evidenceRefs = finding.evidenceRefs.filter((ref) => allowedEvidenceRefs.has(ref));
    if (!finding.evidenceRefs.length) {
      finding.claimType = "model_inference";
      finding.confidence = "low";
    }
  }
  return {
    report,
    responseId: response.id,
    model: response.model,
    provider: getProviderName("report"),
    promptVersion: REPORT_REVISION_PROMPT_VERSION,
    usage: response.usage,
  };
}
