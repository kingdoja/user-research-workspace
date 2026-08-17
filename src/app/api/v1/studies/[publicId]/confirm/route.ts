import { NextResponse } from "next/server";
import { withExternalApiAuth } from "@/lib/api-access";
import { confirmStudyPlan } from "@/lib/studies";

export async function POST(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  return withExternalApiAuth(request, "studies:write", async ({ viewer }) => {
    const result = await confirmStudyPlan(viewer, (await context.params).publicId);
    if (result === "not_found") return NextResponse.json({ error: { code: "not_found", message: "Study not found." } }, { status: 404 });
    return NextResponse.json({ data: { status: result } }, { status: result === "already_confirmed" ? 200 : 202 });
  });
}
