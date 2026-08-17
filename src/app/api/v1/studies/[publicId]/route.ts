import { NextResponse } from "next/server";
import { withExternalApiAuth } from "@/lib/api-access";
import { getStudy } from "@/lib/studies";

export async function GET(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  return withExternalApiAuth(request, "studies:read", async ({ viewer }) => {
    const study = await getStudy(viewer, (await context.params).publicId);
    if (!study) return NextResponse.json({ error: { code: "not_found", message: "Study not found." } }, { status: 404 });
    return NextResponse.json({
      data: {
        publicId: study.publicId,
        title: study.title,
        brief: study.brief,
        productLine: study.productLine,
        status: study.status,
        currentStage: study.currentStage,
        updatedAt: study.updatedAt,
        intent: study.intent,
        workflow: study.workflow,
        plan: study.plan,
      },
    });
  });
}
