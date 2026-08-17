import { NextResponse } from "next/server";
import { withExternalApiAuth } from "@/lib/api-access";
import { listPersonas } from "@/lib/studies";

export async function GET(request: Request) {
  return withExternalApiAuth(request, "personas:read", async ({ viewer }) => {
    const result = await listPersonas(viewer);
    return NextResponse.json({ data: result.personas });
  });
}
