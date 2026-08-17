import { NextResponse } from "next/server";
import { withExternalApiAuth } from "@/lib/api-access";
import { getStudy } from "@/lib/studies";

export async function GET(
  request: Request,
  context: { params: Promise<{ publicId: string }> },
) {
  return withExternalApiAuth(request, "runs:read", async ({ viewer }) => {
    const study = await getStudy(viewer, (await context.params).publicId);
    if (!study) return NextResponse.json({ error: { code: "not_found", message: "Study not found." } }, { status: 404 });
    return NextResponse.json({
      data: {
        studyPublicId: study.publicId,
        current: study.runId ? {
          publicId: study.runHistory.find((run) => run.id === study.runId)?.publicId ?? null,
          status: study.runStatus,
          provider: study.runProvider,
          model: study.runModel,
          error: study.runError,
          startedAt: study.runStartedAt,
          finishedAt: study.runFinishedAt,
        } : null,
        history: study.runHistory.map((run) => ({
          publicId: run.publicId,
          attempt: run.attempt,
          status: run.status,
          provider: run.provider,
          model: run.model,
          error: run.error,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          eventCount: run.eventCount,
          completedSteps: run.completedSteps,
          totalSteps: run.totalSteps,
        })),
        artifacts: study.artifacts,
      },
    });
  });
}
