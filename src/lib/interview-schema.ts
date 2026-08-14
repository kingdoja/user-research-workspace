import { z } from "zod";

export const createInterviewProjectSchema = z.object({
  title: z.string().trim().min(4, "项目名称至少需要 4 个字符").max(120),
  objective: z.string().trim().min(12, "请再具体描述一些访谈目标").max(2000),
  personaPublicIds: z.array(z.string().trim().min(8).max(120)).max(8),
  panelPublicId: z.string().trim().min(8).max(120).nullable().optional(),
  studyPublicId: z.string().trim().min(8).max(120).nullable().optional(),
});

export type CreateInterviewProjectInput = z.infer<typeof createInterviewProjectSchema>;

export const updateInterviewProjectSchema = z.object({ status: z.enum(["completed", "archived"]) });

export const updateInterviewProjectDetailsSchema = z.object({
  objective: z.string().trim().min(12, "请再具体描述一些项目简介").max(2000),
});

export const interviewQuestionSchema = z.object({
  content: z.string().trim().min(4, "问题至少需要 4 个字符").max(1000),
  questionType: z.enum(["open", "single", "multiple"]),
  options: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  aiPrompt: z.string().trim().max(1000).nullable().optional(),
}).superRefine((value, context) => {
  if (value.questionType !== "open" && value.options.length < 2) {
    context.addIssue({ code: "custom", path: ["options"], message: "选择题至少需要两个选项" });
  }
});

export const moveInterviewQuestionSchema = z.object({ direction: z.enum(["up", "down"]) });

export const interviewQuestionImageSchema = z.object({
  imagePath: z.string().trim().min(10).max(500),
});

export const createInterviewInvitationSchema = z.object({
  durationDays: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(30)]).nullable(),
});

export const submitPublicInterviewSchema = z.object({
  participantName: z.string().trim().min(2, "请填写称呼").max(80),
  participantEmail: z.union([z.string().trim().email("邮箱格式无效").max(320), z.literal("")]).optional(),
  answers: z.array(z.object({
    questionPublicId: z.string().trim().min(8).max(120),
    answer: z.union([z.string().trim().min(1).max(4000), z.array(z.string().trim().min(1).max(200)).min(1).max(12)]),
  })).min(1).max(50),
});

export const startRealtimeInterviewSchema = z.object({
  participantName: z.string().trim().min(2, "请填写称呼").max(80),
  participantEmail: z.union([z.string().trim().email("邮箱格式无效").max(320), z.literal("")]).optional(),
});

export const realtimeInterviewTurnSchema = z.object({
  content: z.string().trim().min(1, "请填写回答").max(4000),
  idempotencyKey: z.string().trim().min(8).max(160),
});

export const realtimeInterviewSessionSchema = z.object({
  sessionPublicId: z.string().trim().min(8).max(120),
  resumeToken: z.string().trim().min(20).max(200),
});

export const interviewQualityReviewSchema = z.object({
  relevance: z.number().int().min(1).max(5),
  depth: z.number().int().min(1).max(5),
  followupQuality: z.number().int().min(1).max(5),
  consistency: z.number().int().min(1).max(5),
  evidenceGrounding: z.number().int().min(1).max(5),
  safetyCompliance: z.number().int().min(1).max(5),
  notes: z.string().trim().max(2000).default(""),
});

export const citeInterviewInsightSchema = z.object({
  sessionPublicId: z.string().trim().min(8).max(120),
  insight: z.string().trim().min(10).max(1000),
  attribution: z.enum(["session", "synthesis"]).default("session"),
});
