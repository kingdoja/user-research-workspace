function firstHeaderValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() || null;
}

type RateLimitPolicy = { limit: number; windowMs: number };
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const MAX_RATE_LIMIT_BUCKETS = 10_000;

function requestClientKey(request: Request) {
  return (firstHeaderValue(request.headers.get("x-real-ip"))
    ?? firstHeaderValue(request.headers.get("x-forwarded-for"))
    ?? "unknown").slice(0, 120);
}

function pruneRateLimitBuckets(now: number) {
  if (rateLimitBuckets.size < MAX_RATE_LIMIT_BUCKETS) return;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
  while (rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
    const oldestKey = rateLimitBuckets.keys().next().value;
    if (typeof oldestKey !== "string") break;
    rateLimitBuckets.delete(oldestKey);
  }
}

export function checkRateLimit(request: Request, name: string, policy: RateLimitPolicy, subject?: string) {
  const now = Date.now();
  pruneRateLimitBuckets(now);
  const key = `${name}:${(subject ?? requestClientKey(request)).slice(0, 240)}`;
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + policy.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  current.count += 1;
  if (current.count <= policy.limit) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}

export function rateLimitResponse(retryAfterSeconds: number) {
  return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试" }), {
    status: 429,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfterSeconds),
    },
  });
}

function getPublicRequestOrigin(request: Request) {
  const configuredOrigin = process.env.PUBLIC_APP_ORIGIN?.trim();
  if (configuredOrigin) {
    try {
      return new URL(configuredOrigin).origin;
    } catch {
      // Fall through to the request origin for local development.
    }
  }
  const requestUrl = new URL(request.url);
  const forwardedProtocol = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : requestUrl.protocol.slice(0, -1);
  const host = firstHeaderValue(request.headers.get("x-forwarded-host"))
    ?? request.headers.get("host")?.trim();

  if (!host) {
    return requestUrl.origin;
  }

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return requestUrl.origin;
  }
}

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");

  if (!origin) {
    return true;
  }

  const configuredOrigin = process.env.PUBLIC_APP_ORIGIN?.trim();
  if (process.env.NODE_ENV === "production") {
    if (!configuredOrigin) return false;
    try {
      if (new URL(configuredOrigin).origin !== configuredOrigin.replace(/\/$/, "")) return false;
    } catch {
      return false;
    }
  }

  try {
    return new URL(origin).origin === getPublicRequestOrigin(request);
  } catch {
    return false;
  }
}

export function safeCallbackPath(value: string | null | undefined, fallback = "/newstudy") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }

  return value;
}
