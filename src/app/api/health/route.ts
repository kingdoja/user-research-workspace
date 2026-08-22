import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "atypica-rebuild",
  }, {
    headers: { "cache-control": "no-store" },
  });
}
