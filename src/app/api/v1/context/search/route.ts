import { NextResponse } from "next/server";
import { withExternalApiAuth } from "@/lib/api-access";
import { contextSearchInputSchema, retrieveContext } from "@/lib/context-system";

export async function POST(request: Request) {
  return withExternalApiAuth(request, "context:read", async ({ viewer }) => {
    const parsed = contextSearchInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: { code: "invalid_request", message: parsed.error.issues[0]?.message ?? "Invalid search input." } }, { status: 400 });
    }
    const snapshot = await retrieveContext({
      workspaceId: viewer.workspaceId,
      userId: viewer.userId,
      query: parsed.data.query,
      assetTypes: parsed.data.assetTypes,
      scopes: parsed.data.scopes,
      purpose: parsed.data.purpose,
      limit: parsed.data.limit,
    });
    return NextResponse.json({ data: snapshot });
  });
}
