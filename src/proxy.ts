import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const protectedRoutePrefixes = [
  "/account",
  "/agent",
  "/context",
  "/interview/experiments",
  "/interview/projects",
  "/newstudy",
  "/panel",
  "/platform",
  "/skills",
  "/studies",
  "/study",
] as const;

function isProtectedRoute(pathname: string) {
  return protectedRoutePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/qa-agent-console" && process.env.ENABLE_QA_ROUTES !== "1") {
    return new NextResponse(null, { status: 404 });
  }
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    return response;
  }

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data } = await supabase.auth.getClaims();

  if (!data?.claims && isProtectedRoute(request.nextUrl.pathname)) {
    const signInUrl = new URL("/auth/signin", request.url);
    signInUrl.searchParams.set(
      "callbackUrl",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    const redirectResponse = NextResponse.redirect(signInUrl);

    for (const cookie of response.cookies.getAll()) {
      redirectResponse.cookies.set(cookie);
    }

    return redirectResponse;
  }

  return response;
}

export const config = {
  matcher: [
    "/account/:path*",
    "/agent/:path*",
    "/api/:path*",
    "/context/:path*",
    "/interview/:path*",
    "/newstudy/:path*",
    "/panel/:path*",
    "/persona/:path*",
    "/platform/:path*",
    "/qa-agent-console",
    "/skills/:path*",
    "/studies/:path*",
    "/study/:path*",
  ],
};
