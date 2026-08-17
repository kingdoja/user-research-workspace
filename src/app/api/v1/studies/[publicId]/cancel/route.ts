import { NextResponse } from "next/server";
import { withExternalApiAuth } from "@/lib/api-access";
import { cancelStudyRun } from "@/lib/research-harness";

export async function POST(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  return withExternalApiAuth(request, "runs:write", async ({ viewer }) => {
    const result = await cancelStudyRun(viewer, (await context.params).publicId);
    if (result === "not_found") return NextResponse.json({ error: { code: "not_found", message: "Study not found." } }, { status: 404 });
    if (result === "forbidden") return NextResponse.json({ error: { code: "forbidden", message: "This key cannot cancel the run." } }, { status: 403 });
    if (result === "not_running") return NextResponse.json({ error: { code: "not_running", message: "Study has no cancellable run." } }, { status: 409 });
    return NextResponse.json({ data: { status: result } }, { status: result === "requested" ? 202 : 200 });
  });
}
