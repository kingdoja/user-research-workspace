import { z } from "zod";
import { taskInputFieldSchema, type TaskInputField } from "@/lib/task-input-contract";
import { inferResearchAgentTaskTemplate, type ResearchAgentTaskTemplateName } from "@/lib/research-agent-templates";

export const RESEARCH_AGENT_CONTROLLER_VERSION = "research-agent-controller-v2";

const actionTypeSchema = z.enum(["call_tool", "replan", "ask_user", "finish"]);
const rawInputFieldSchema = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  type: z.enum(["text", "url_list", "choice"]),
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(2000).nullable(),
  maxItems: z.number().int().min(1).max(8).nullable(),
  options: z.array(z.string().min(1).max(160)).min(1).max(8).nullable(),
}).strict();

const rawAgentActionSchema = z.object({
  type: actionTypeSchema,
  summary: z.string().min(2).max(600),
  taskKey: z.string().max(160).nullable(),
  toolName: z.string().max(80).nullable(),
  arguments: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().max(1200).nullable(),
  requestedTasks: z.array(z.object({
    key: z.string().min(1).max(160),
    title: z.string().min(2).max(240),
    toolName: z.string().min(1).max(80),
    template: z.string().min(1).max(80).nullable().optional(),
    dependsOn: z.array(z.string().max(160)).max(32),
    input: z.record(z.string(), z.unknown()),
  })).max(8),
  question: z.string().max(1200).nullable(),
  options: z.array(z.string().min(1).max(160)).max(8),
  fields: z.array(rawInputFieldSchema).max(8),
});

export type AgentAction =
  | {
      type: "call_tool";
      summary: string;
      taskKey: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "replan";
      summary: string;
      reason: string;
      requestedTasks: Array<{
        key: string;
        title: string;
        toolName: string;
        template?: ResearchAgentTaskTemplateName | null;
        dependsOn: string[];
        input: Record<string, unknown>;
      }>;
    }
  | {
      type: "ask_user";
      summary: string;
      taskKey: string;
      question: string;
      options: string[];
      fields: TaskInputField[];
    }
  | {
      type: "finish";
      summary: string;
    };

export const researchAgentActionJsonSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["call_tool", "replan", "ask_user", "finish"] },
    summary: { type: "string", minLength: 2, maxLength: 600 },
    taskKey: { type: "string", maxLength: 160 },
    toolName: { type: "string", maxLength: 80 },
    arguments: { type: "string", maxLength: 32000 },
    reason: { type: "string", maxLength: 1200 },
    requestedTasks: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          key: { type: "string", minLength: 1, maxLength: 160 },
          title: { type: "string", minLength: 2, maxLength: 240 },
          toolName: { type: "string", minLength: 1, maxLength: 80 },
          template: { type: "string", minLength: 1, maxLength: 80 },
          dependsOn: { type: "array", maxItems: 32, items: { type: "string", maxLength: 160 } },
          input: { type: "string", maxLength: 32000 },
        },
        required: ["key", "title", "toolName", "template", "dependsOn", "input"],
        additionalProperties: false,
      },
    },
    question: { type: "string", maxLength: 1200 },
    options: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 160 } },
    fields: {
      type: "array", maxItems: 8,
      items: {
        type: "object",
        properties: {
          key: { type: "string", minLength: 1, maxLength: 80 },
          label: { type: "string", minLength: 1, maxLength: 160 },
          type: { type: "string", enum: ["text", "url_list", "choice"] },
          required: { type: "boolean" },
          maxLength: { type: "integer", minimum: 0, maximum: 2000 },
          maxItems: { type: "integer", minimum: 0, maximum: 8 },
          options: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 160 } },
        },
        required: ["key", "label", "type", "required", "maxLength", "maxItems", "options"], additionalProperties: false,
      },
    },
  },
  required: ["type", "summary", "taskKey", "toolName", "arguments", "reason", "requestedTasks", "question", "options", "fields"],
  additionalProperties: false,
} as const;

export function parseResearchAgentAction(value: unknown): AgentAction {
  const record: Record<string, unknown> | null = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const normalized = record ? {
    ...record,
    taskKey: record.taskKey === "" ? null : record.taskKey,
    toolName: record.toolName === "" ? null : record.toolName,
    reason: record.reason === "" ? null : record.reason,
    question: record.question === "" ? null : record.question,
    arguments: typeof record.arguments === "string"
      ? JSON.parse(record.arguments || "{}") as unknown
      : record.arguments,
    requestedTasks: Array.isArray(record.requestedTasks) ? record.requestedTasks.map((task) => {
      if (!task || typeof task !== "object" || Array.isArray(task)) return task;
      const item = task as Record<string, unknown>;
      return {
        ...item,
        input: typeof item.input === "string" ? JSON.parse(item.input || "{}") as unknown : item.input,
      };
    }) : record.requestedTasks,
    fields: Array.isArray(record.fields) ? record.fields.map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return field;
      const item = field as Record<string, unknown>;
      return {
        ...item,
        maxLength: item.maxLength === 0 ? null : item.maxLength,
        maxItems: item.maxItems === 0 ? null : item.maxItems,
        options: Array.isArray(item.options) && item.options.length === 0 ? null : item.options,
      };
    }) : record.fields,
  } : value;
  const parsed = rawAgentActionSchema.parse(normalized);
  if (parsed.type === "call_tool") {
    if (!parsed.taskKey || !parsed.toolName || !parsed.arguments) {
      throw new Error("AGENT_ACTION_INVALID:call_tool_requires_task");
    }
    return {
      type: "call_tool",
      summary: parsed.summary,
      taskKey: parsed.taskKey,
      toolName: parsed.toolName,
      arguments: parsed.arguments,
    };
  }
  if (parsed.type === "replan") {
    if (!parsed.reason || !parsed.requestedTasks.length) {
      throw new Error("AGENT_ACTION_INVALID:replan_requires_tasks");
    }
    return {
      type: "replan",
      summary: parsed.summary,
      reason: parsed.reason,
      requestedTasks: parsed.requestedTasks.map((task) => ({
        ...task,
        template: (task.template ?? inferResearchAgentTaskTemplate(task.toolName)) as ResearchAgentTaskTemplateName | null,
      })),
    };
  }
  if (parsed.type === "ask_user") {
    if (!parsed.taskKey || !parsed.question) {
      throw new Error("AGENT_ACTION_INVALID:ask_user_requires_task_and_question");
    }
    const fields = parsed.fields.map((field) => taskInputFieldSchema.parse({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      ...(field.maxLength === null ? {} : { maxLength: field.maxLength }),
      ...(field.maxItems === null ? {} : { maxItems: field.maxItems }),
      ...(field.options === null ? {} : { options: field.options }),
    }));
    return {
      type: "ask_user",
      summary: parsed.summary,
      taskKey: parsed.taskKey,
      question: parsed.question,
      options: parsed.options,
      fields,
    };
  }
  return { type: "finish", summary: parsed.summary };
}
