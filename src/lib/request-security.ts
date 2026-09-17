import { createHash, randomUUID } from "node:crypto";
import { getDatabase } from "@/lib/db";

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

function checkMemoryRateLimit(request: Request, name: string, policy: RateLimitPolicy, subject?: string) {
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

export async function checkRateLimit(request: Request, name: string, policy: RateLimitPolicy, subject?: string) {
  const backend = process.env.RATE_LIMIT_BACKEND?.trim().toLowerCase()
    || (process.env.NODE_ENV === "production" ? "database" : "memory");
  if (backend === "memory") return checkMemoryRateLimit(request, name, policy, subject);
  if (backend !== "database") throw new Error("RATE_LIMIT_BACKEND must be either memory or database");

  const rawKey = `${name}:${policy.limit}:${policy.windowMs}:${(subject ?? requestClientKey(request)).slice(0, 240)}`;
  const key = createHash("sha256").update(rawKey).digest("hex");
  try {
    const database = await getDatabase();
    const result = await database.query<{ count: number; retry_after_seconds: number }>(
      `with expired as (
         delete from request_rate_limits where key_hash in (
           select key_hash from request_rate_limits where expires_at <= now() limit 100
         ) returning key_hash
       )
       insert into request_rate_limits (key_hash, request_count, expires_at)
       values ($1, 1, now() + ($2::double precision * interval '1 millisecond'))
       on conflict (key_hash) do update set
         request_count = case when request_rate_limits.expires_at <= now()
           then 1 else request_rate_limits.request_count + 1 end,
         expires_at = case when request_rate_limits.expires_at <= now()
           then now() + ($2::double precision * interval '1 millisecond')
           else request_rate_limits.expires_at end,
         updated_at = now()
       returning request_count as count,
         greatest(1, ceil(extract(epoch from (expires_at - now()))))::int as retry_after_seconds`,
      [key, policy.windowMs],
    );
    const bucket = result.rows[0];
    return {
      allowed: Boolean(bucket && bucket.count <= policy.limit),
      retryAfterSeconds: bucket && bucket.count > policy.limit ? bucket.retry_after_seconds : 0,
    };
  } catch (error) {
    console.error("Shared rate limiter failed", { name, error });
    if (process.env.RATE_LIMIT_FAIL_OPEN === "1" && process.env.NODE_ENV !== "production") {
      return checkMemoryRateLimit(request, name, policy, subject);
    }
    return { allowed: false, retryAfterSeconds: 1 };
  }
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

export function internalErrorResponse(error: unknown, message = "服务器暂时无法处理请求", status = 500) {
  const requestId = randomUUID();
  console.error("API request failed", { requestId, error });
  return new Response(JSON.stringify({ error: message, code: "INTERNAL_ERROR", requestId }), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
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

function getIncomingRequestOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedProtocol = firstHeaderValue(request.headers.get("x-forwarded-proto"));
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : requestUrl.protocol.slice(0, -1);
  const host = firstHeaderValue(request.headers.get("x-forwarded-host"))
    ?? request.headers.get("host")?.trim();
  if (!host) return requestUrl.origin;
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
  let normalizedConfiguredOrigin: string | null = null;
  if (process.env.NODE_ENV === "production") {
    if (!configuredOrigin) return false;
    try {
      normalizedConfiguredOrigin = new URL(configuredOrigin).origin;
      if (normalizedConfiguredOrigin !== configuredOrigin.replace(/\/$/, "")) return false;
    } catch {
      return false;
    }
  }

  try {
    const requestOrigin = getPublicRequestOrigin(request);
    // Proxies may expose the app on a temporary IP/host while PUBLIC_APP_ORIGIN
    // still points at the canonical hostname. Accept either public origin.
    return new URL(origin).origin === requestOrigin
      || new URL(origin).origin === getIncomingRequestOrigin(request)
      || (normalizedConfiguredOrigin !== null && new URL(origin).origin === normalizedConfiguredOrigin);
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
