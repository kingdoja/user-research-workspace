import { z } from "zod";

export const personaInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  archetype: z.string().trim().min(2).max(80),
  age: z.number().int().min(18).max(90),
  city: z.string().trim().min(2).max(80),
  occupation: z.string().trim().min(2).max(120),
  commute: z.string().trim().min(5).max(500),
  budget: z.string().trim().min(2).max(120),
  currentSituation: z.string().trim().min(10).max(1000),
  goals: z.array(z.string().trim().min(2).max(200)).min(2).max(6),
  painPoints: z.array(z.string().trim().min(2).max(200)).min(2).max(6),
  decisionStyle: z.string().trim().min(8).max(500),
  tags: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
  visibility: z.enum(["private", "workspace"]),
  addToPanelPublicIds: z.array(z.string().trim().min(8).max(120)).max(20),
});
