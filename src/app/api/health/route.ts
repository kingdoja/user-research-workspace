import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "cognara-ai",
  }, {
    headers: { "cache-control": "no-store" },
  });
}
