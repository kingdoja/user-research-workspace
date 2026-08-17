import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import {
  createCollaborationDelegation,
  createCollaborationPublication,
  listCollaboration,
} from "@/lib/platform-control";

const publicationSchema = z.object({
  kind: z.literal("publication"),
  recipientWorkspacePublicId: z.string().trim().min(8).max(120),
  artifactType: z.enum(["study", "report", "context", "skill"]),
  artifactPublicId: z.string().trim().min(8).max(160),
  title: z.string().trim().min(2).max(160).optional(),
  summary: z.string().trim().max(1200).optional(),
  capabilities: z.array(z.enum(["view", "import", "delegate"])).min(1).max(3),
});

const delegationSchema = z.object({
  kind: z.literal("delegation"),
  recipientWorkspacePublicId: z.string().trim().min(8).max(120),
  publicationPublicId: z.string().trim().min(8).max(120).nullable().optional(),
  assigneeUserPublicId: z.string().trim().min(8).max(120).nullable().optional(),
  title: z.string().trim().min(2).max(160),
  instructions: z.string().trim().max(4000),
  dueAt: z.iso.datetime().nullable().optional(),
});

const inputSchema = z.discriminatedUnion("kind", [publicationSchema, delegationSchema]);

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json(await listCollaboration(viewer));
}

export async function POST(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "协作请求参数不完整" }, { status: 400 });
  const result = parsed.data.kind === "publication"
    ? await createCollaborationPublication(viewer, parsed.data)
    : await createCollaborationDelegation(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "只有工作区管理员可以发起跨工作区协作" }, { status: 403 });
  if (result === "recipient_not_found") return NextResponse.json({ error: "目标工作区不存在" }, { status: 404 });
  if (result === "artifact_not_found") return NextResponse.json({ error: "当前工作区中找不到该资产或资产不可发布" }, { status: 404 });
  if (result === "assignee_not_found") return NextResponse.json({ error: "目标成员不属于接收工作区" }, { status: 404 });
  if (result === "publication_not_delegable") return NextResponse.json({ error: "发布包不存在、尚未提交或未授予委托权限" }, { status: 409 });
  return NextResponse.json(result, { status: 201 });
}
