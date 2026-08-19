import { z } from "zod";

export const taskInputFieldSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(80),
  label: z.string().min(1).max(160),
  type: z.enum(["text", "url_list", "choice"]),
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(2000).optional(),
  maxItems: z.number().int().min(1).max(8).optional(),
  options: z.array(z.string().min(1).max(160)).min(1).max(8).optional(),
}).strict().superRefine((field, context) => {
  if (field.type === "choice" && !field.options?.length) {
    context.addIssue({ code: "custom", message: "选择字段必须提供选项", path: ["options"] });
  }
  if (field.type !== "choice" && field.options) {
    context.addIssue({ code: "custom", message: "只有选择字段可以提供选项", path: ["options"] });
  }
});

export const taskInputRequestSchema = z.object({
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(1200),
  fields: z.array(taskInputFieldSchema).min(1).max(8),
}).strict().superRefine((request, context) => {
  const keys = new Set<string>();
  request.fields.forEach((field, index) => {
    if (keys.has(field.key)) {
      context.addIssue({ code: "custom", message: "输入字段名称不能重复", path: ["fields", index, "key"] });
    }
    keys.add(field.key);
  });
});

export type TaskInputField = z.infer<typeof taskInputFieldSchema>;
export type TaskInputRequest = z.infer<typeof taskInputRequestSchema>;

export function parseTaskInputRequest(value: unknown): TaskInputRequest | null {
  const parsed = taskInputRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const legacy = value as Record<string, unknown>;
  if ("fields" in legacy) return null;
  const options = Array.isArray(legacy.options)
    ? legacy.options.filter((option): option is string => typeof option === "string")
    : [];
  return taskInputRequestSchema.safeParse({
    title: typeof legacy.title === "string" ? legacy.title : "需要补充输入",
    description: typeof legacy.description === "string" ? legacy.description : "补充信息后将从当前 checkpoint 继续。",
    fields: options.length
      ? [{ key: "selectedOption", label: "选择处理方式", type: "choice", required: true, options }]
      : [
          { key: "focus", label: "补充研究焦点", type: "text", required: false, maxLength: 600 },
          { key: "sourceUrls", label: "可信公开 URL", type: "url_list", required: false, maxItems: 8 },
        ],
  }).data ?? null;
}

export function validateTaskInputResponse(request: TaskInputRequest, value: unknown):
  | { success: true; data: Record<string, string | string[]> }
  | { success: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { success: false, error: "输入格式无效" };
  }
  const response = value as Record<string, unknown>;
  const allowedKeys = new Set(request.fields.map((field) => field.key));
  if (Object.keys(response).some((key) => !allowedKeys.has(key))) {
    return { success: false, error: "提交内容包含未请求的字段" };
  }

  const data: Record<string, string | string[]> = {};
  for (const field of request.fields) {
    const raw = response[field.key];
    if (field.type === "url_list") {
      if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
        if (field.required) return { success: false, error: `请填写${field.label}` };
        continue;
      }
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
        return { success: false, error: `${field.label}格式无效` };
      }
      const urls = raw.map((item) => item.trim()).filter(Boolean);
      if (urls.length > (field.maxItems ?? 8)) return { success: false, error: `${field.label}数量过多` };
      if (urls.some((item) => {
        try {
          const url = new URL(item);
          return url.protocol !== "http:" && url.protocol !== "https:";
        } catch {
          return true;
        }
      })) return { success: false, error: `${field.label}必须是公开 HTTP(S) URL` };
      if (urls.length) data[field.key] = urls;
      continue;
    }

    if (raw === undefined || raw === "") {
      if (field.required) return { success: false, error: `请选择或填写${field.label}` };
      continue;
    }
    if (typeof raw !== "string") return { success: false, error: `${field.label}格式无效` };
    const text = raw.trim();
    if (!text) {
      if (field.required) return { success: false, error: `请选择或填写${field.label}` };
      continue;
    }
    if (field.type === "choice" && !field.options?.includes(text)) {
      return { success: false, error: `${field.label}选项无效` };
    }
    if (text.length > (field.maxLength ?? (field.type === "choice" ? 160 : 600))) {
      return { success: false, error: `${field.label}内容过长` };
    }
    data[field.key] = text;
  }

  if (!Object.keys(data).length) return { success: false, error: "请至少补充一项信息" };
  return { success: true, data };
}
