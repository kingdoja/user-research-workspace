import { z } from "zod";

export const SANDBOX_PROTOCOL = "atypica.sandbox/v1" as const;

const sandboxPathSchema = z.string().trim().min(1).max(180)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/)
  .refine(
    (value) => value !== "package.json" && value !== ".atypica" && !value.startsWith(".atypica/"),
    "Path is reserved by the sandbox runner",
  );

const sandboxFilesSchema = z.record(sandboxPathSchema, z.string().max(120_000))
  .refine((files) => Object.keys(files).length >= 1 && Object.keys(files).length <= 32, {
    message: "Source bundle must contain 1-32 files",
  })
  .refine(
    (files) => Object.values(files).reduce((total, content) => total + Buffer.byteLength(content, "utf8"), 0) <= 256_000,
    { message: "Source bundle exceeds 256 KB" },
  );

export const sandboxExecutionRequestSchema = z.object({
  protocol: z.literal(SANDBOX_PROTOCOL),
  runtime: z.object({
    language: z.enum(["javascript", "python"]),
    entrypoint: sandboxPathSchema,
  }).strict(),
  files: sandboxFilesSchema,
  input: z.record(z.string(), z.unknown()),
  limits: z.object({
    timeoutMs: z.number().int().min(1_000).max(120_000),
    maxMemoryMb: z.number().int().min(32).max(512),
    maxOutputBytes: z.number().int().min(1_024).max(1_048_576),
    networkAccess: z.boolean(),
  }).strict(),
}).strict().superRefine((request, context) => {
  if (!Object.hasOwn(request.files, request.runtime.entrypoint)) {
    context.addIssue({
      code: "custom",
      message: "Entrypoint is missing from source files",
      path: ["runtime", "entrypoint"],
    });
  }
  const expectedExtension = request.runtime.language === "javascript" ? /\.(?:js|mjs)$/ : /\.py$/;
  if (!expectedExtension.test(request.runtime.entrypoint)) {
    context.addIssue({
      code: "custom",
      message: `Entrypoint extension does not match ${request.runtime.language}`,
      path: ["runtime", "entrypoint"],
    });
  }
});

export type SandboxExecutionRequest = z.infer<typeof sandboxExecutionRequestSchema>;

export type SandboxExecutionResponse = {
  protocol: typeof SANDBOX_PROTOCOL;
  executionId: string;
  status: "completed" | "failed";
  exitCode: number | null;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  metrics: {
    durationMs: number;
  };
};
