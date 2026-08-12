import { z } from "zod";

export const createInterviewProjectSchema = z.object({
  title: z.string().trim().min(4, "项目名称至少需要 4 个字符").max(120),
  objective: z.string().trim().min(12, "请再具体描述一些访谈目标").max(2000),
  personaPublicIds: z.array(z.string().trim().min(8).max(120)).min(1, "至少选择一个 Persona").max(8),
  panelPublicId: z.string().trim().min(8).max(120).nullable().optional(),
  studyPublicId: z.string().trim().min(8).max(120).nullable().optional(),
});

export type CreateInterviewProjectInput = z.infer<typeof createInterviewProjectSchema>;

export const updateInterviewProjectSchema = z.object({
  status: z.enum(["completed", "archived"]),
});

export const citeInterviewInsightSchema = z.object({
  sessionPublicId: z.string().trim().min(8).max(120),
  insight: z.string().trim().min(10).max(1000),
});
