import { NextResponse } from "next/server";
import { z } from "zod";
import { withExternalApiAuth } from "@/lib/api-access";
import { createStudy, listStudies } from "@/lib/studies";

const createStudySchema = z.object({
  brief: z.string().trim().min(12).max(4000),
  productLine: z.enum(["research", "market_insight"]).default("research"),
});

export async function GET(request: Request) {
  return withExternalApiAuth(request, "studies:read", async ({ viewer }) => (
    NextResponse.json({ data: await listStudies(viewer, 50) })
  ));
}

export async function POST(request: Request) {
  return withExternalApiAuth(request, "studies:write", async ({ viewer }) => {
    const parsed = createStudySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: { code: "invalid_request", message: parsed.error.issues[0]?.message ?? "Invalid study input." } }, { status: 400 });
    }
    const publicId = await createStudy(viewer, parsed.data.brief, parsed.data.productLine);
    return NextResponse.json({ data: { publicId, status: "planning" } }, { status: 201 });
  });
}
