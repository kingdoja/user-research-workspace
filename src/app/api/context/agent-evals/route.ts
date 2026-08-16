import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import {
  agentEvalSuiteInputSchema,
  createAgentEvalSuite,
  listAgentEvalSuites,
} from "@/lib/agent-evals";
import { isSameOriginRequest } from "@/lib/request-security";

export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  return NextResponse.json({ suites: await listAgentEvalSuites(viewer) });
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const parsed = agentEvalSuiteInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Agent Eval 定义无效" }, { status: 400 });
  const result = await createAgentEvalSuite(viewer, parsed.data);
  if (result === "forbidden") return NextResponse.json({ error: "只有管理员可以创建 Agent Eval" }, { status: 403 });
  if (result === "source_not_authorized") return NextResponse.json({ error: "Eval source 必须是当前工作区已授权、可用且不可变的版本" }, { status: 400 });
  if (result === "expected_source_not_declared") return NextResponse.json({ error: "期望引用必须同时声明为 Eval source" }, { status: 400 });
  if (result === "duplicate_case_key" || result === "duplicate_source") return NextResponse.json({ error: "Eval case 或 source 重复" }, { status: 400 });
  return NextResponse.json(result, { status: 201 });
}
