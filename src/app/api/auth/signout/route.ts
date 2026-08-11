import { NextResponse } from "next/server";
import { deleteCurrentSession } from "@/lib/auth";
import { isSameOriginRequest } from "@/lib/request-security";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源无效" }, { status: 403 });
  }

  await deleteCurrentSession();
  return NextResponse.json({ redirectTo: "/auth/signin" });
}
